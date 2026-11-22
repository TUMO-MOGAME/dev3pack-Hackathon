//! Guardians: seats (trusted people) with backups and monitors, succession when a holder dies,
//! monitor objections, the fallback plan and asset photo hashes.
//! Spec: docs/guardians-spec.md §2 and docs/program-spec.md ("Guardians").
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::{
    account_exists, close_program_account, count_bits, now, objection_is_open, read_account, record_proof_of_life,
    transfer_checked_cpi, write_account,
};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

fn is_set(k: &Pubkey) -> bool {
    *k != Pubkey::default()
}

/// Moves a lone second entry into the first slot and rejects a duplicate pair.
fn compact_pair(pair: [Pubkey; 2]) -> Option<[Pubkey; 2]> {
    let out = if is_set(&pair[0]) { pair } else { [pair[1], Pubkey::default()] };
    if is_set(&out[1]) && out[0] == out[1] {
        return None;
    }
    Some(out)
}

/// Backups must differ from the owner, the agent, every current holder (this one included) and each other.
fn validate_backups(estate: &Estate, backups: [Pubkey; 2]) -> Result<[Pubkey; 2]> {
    let b = compact_pair(backups).ok_or(HeirloomError::BadBackup)?;
    for k in b.iter().filter(|k| is_set(k)) {
        require!(*k != estate.owner && *k != estate.agent, HeirloomError::BadBackup);
        require!(estate.verifier_index(k).is_none(), HeirloomError::BadBackup);
    }
    Ok(b)
}

/// Monitors must differ from the holder they watch and from each other.
fn validate_monitors(holder: &Pubkey, monitors: [Pubkey; 2]) -> Result<[Pubkey; 2]> {
    let m = compact_pair(monitors).ok_or(HeirloomError::BadMonitor)?;
    for k in m.iter().filter(|k| is_set(k)) {
        require!(k != holder, HeirloomError::BadMonitor);
    }
    Ok(m)
}

/// A living trusted person, a monitor (of `seat`) or an active beneficiary of this estate; never the agent,
/// who already reviews every report.
fn is_participant(estate: &Account<Estate>, who: &Pubkey, seat: Option<&Seat>, beneficiary: Option<&Beneficiary>) -> bool {
    let key = estate.key();
    *who != estate.agent
        && (estate.verifier_index(who).is_some()
            || seat.is_some_and(|s| s.estate == key && s.is_monitor(who))
            || beneficiary.is_some_and(|b| b.estate == key && b.wallet == *who && b.active))
}

/// Who may report or confirm a fallback recipient's death: a participant or a living listed recipient.
fn is_fallback_participant(
    estate: &Account<Estate>,
    guard: &Guard,
    who: &Pubkey,
    seat: Option<&Seat>,
    beneficiary: Option<&Beneficiary>,
) -> bool {
    is_participant(estate, who, seat, beneficiary)
        || (*who != estate.agent && (0..FALLBACK_COUNT).any(|i| guard.is_living_recipient(i) && guard.fallback[i] == *who))
}

/// Drops `key` from a pair and compacts it.
fn without(pair: [Pubkey; 2], key: &Pubkey) -> [Pubkey; 2] {
    let p = pair.map(|k| if k == *key { Pubkey::default() } else { k });
    if is_set(&p[0]) { p } else { [p[1], Pubkey::default()] }
}

/// The owner's death is established for the fallback: estate Unlocked, or the agent did not reject the claim.
fn owner_death_established(estate: &Estate) -> bool {
    estate.status == EstateStatus::Unlocked || estate.death_verdict.open_to_people()
}

/// A death the agent only referred, with no trusted people to decide it, waits twice as long.
fn fallback_delay(estate: &Estate, guard: &Guard) -> i64 {
    let times = if estate.status == EstateStatus::Active && estate.death_verdict == Verdict::Referred { 2 } else { 1 };
    guard.fallback_wait().saturating_mul(times)
}

/// The countdown still runs: started for this death, and the owner has shown no life since.
fn countdown_valid(estate: &Estate, guard: &Guard) -> bool {
    guard.fallback_started_at != 0
        && estate.last_heartbeat < guard.fallback_started_at
        && estate.death_pending_since <= guard.fallback_started_at
}

/// An Open Fallback objection lapses (counts as Dismissed) once `fallback_wait_secs` have passed since it
/// was raised without it being upheld, so a missing or tied vote can never lock the vault forever. One raised
/// before the owner's last sign of life is void, with its votes.
fn fallback_objection_lapsed(o: &Objection, estate: &Estate, wait: i64, ts: i64) -> Result<bool> {
    if o.kind != TargetKind::Fallback || o.status != ObjectionStatus::Open {
        return Ok(false);
    }
    if o.voided_by_owner(estate) {
        return Ok(true);
    }
    let lapses_at = o.raised_at.checked_add(wait).ok_or(HeirloomError::MathOverflow)?;
    Ok(ts >= lapses_at)
}

/// An upheld objection or dispute on a claim: an Open claim is cancelled (Rejected).
pub(crate) fn uphold_on_claim(info: &AccountInfo) -> Result<()> {
    let mut claim: Claim = read_account(info)?;
    if claim.status == ClaimStatus::Open {
        claim.status = ClaimStatus::Rejected;
        write_account(info, &claim)?;
    }
    Ok(())
}

/// An upheld objection or dispute on an unlock: the death claim is cleared and the estate is Active again.
pub(crate) fn uphold_on_unlock(estate: &mut Estate) {
    if estate.status != EstateStatus::Unlocked {
        estate.clear_death_claim();
        estate.status = EstateStatus::Active;
    }
}

/// Who gains if the challenged action goes ahead: they neither raise its one challenge nor dismiss it.
fn interested_party(kind: TargetKind, estate: &Estate, guard: &Guard, target: Option<&AccountInfo>) -> Result<Pubkey> {
    Ok(match kind {
        TargetKind::Claim => read_account::<Claim>(target.ok_or(HeirloomError::BadStatus)?)?.beneficiary,
        TargetKind::Hardship => read_account::<Hardship>(target.ok_or(HeirloomError::BadStatus)?)?.beneficiary,
        TargetKind::Unlock => estate.death_submitted_by,
        TargetKind::Fallback => guard.next_fallback_recipient(),
        TargetKind::Sale | TargetKind::Succession => Pubkey::default(),
    })
}

fn emit_seat_configured(seat: &Seat) -> Result<()> {
    emit!(SeatConfigured {
        estate: seat.estate,
        seat_index: seat.index,
        holder: seat.holder,
        backups: seat.backups,
        monitors: seat.monitors,
        generation: seat.generation,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== init_guard

#[derive(Accounts)]
pub struct InitGuard<'info> {
    /// The owner (estate Active): the waits can't be changed later, so never the agent. Pays rent.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        init,
        payer = authority,
        space = 8 + Guard::INIT_SPACE,
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump
    )]
    pub guard: Account<'info, Guard>,

    pub system_program: Program<'info, System>,
}

pub fn init_guard_handler(
    ctx: Context<InitGuard>,
    objection_window_secs: i64,
    succession_wait_secs: i64,
    fallback_wait_secs: i64,
) -> Result<()> {
    let estate = &ctx.accounts.estate;
    let authority = ctx.accounts.authority.key();
    require!(authority == estate.owner, HeirloomError::NotOwner);
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    for wait in [objection_window_secs, succession_wait_secs, fallback_wait_secs] {
        require!((0..=MAX_GUARD_WAIT_SECS).contains(&wait), HeirloomError::TimeOutOfRange);
    }

    let estate_key = estate.key();
    let bump = ctx.bumps.guard;
    ctx.accounts.guard.set_inner(Guard {
        estate: estate_key,
        objection_window_secs,
        succession_wait_secs,
        fallback_wait_secs,
        open_objections: 0,
        fallback: [Pubkey::default(); FALLBACK_COUNT],
        fallback_dead: 0,
        fallback_started_at: 0,
        fallback_done: false,
        bump,
    });

    emit!(GuardInitialized {
        estate: estate_key,
        objection_window_secs,
        succession_wait_secs,
        fallback_wait_secs,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== init_seat

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct InitSeat<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        init,
        payer = owner,
        space = 8 + Seat::INIT_SPACE,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump
    )]
    pub seat: Account<'info, Seat>,

    pub system_program: Program<'info, System>,
}

pub fn init_seat_handler(
    ctx: Context<InitSeat>,
    index: u8,
    backups: [Pubkey; 2],
    monitors: [Pubkey; 2],
) -> Result<()> {
    require!((index as usize) < VERIFIER_COUNT, HeirloomError::InvalidAmount);
    let estate = &ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);

    let holder = estate.verifiers[index as usize];
    let backups = validate_backups(estate, backups)?;
    let monitors = validate_monitors(&holder, monitors)?;

    let estate_key = estate.key();
    let bump = ctx.bumps.seat;
    ctx.accounts.seat.set_inner(Seat {
        estate: estate_key,
        index,
        holder,
        backups,
        monitors,
        generation: 0,
        vacant: !is_set(&holder),
        death_cert_hash: [0u8; 32],
        death_reported_by: Pubkey::default(),
        death_verdict: Verdict::Pending,
        death_confirmed_by: Pubkey::default(),
        death_pending_since: 0,
        bump,
    });
    emit_seat_configured(&ctx.accounts.seat)
}

// ====================================================================== set_seat_backups

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct SetSeatBackups<'info> {
    /// The owner (estate Active) or the seat's current holder.
    pub authority: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn set_seat_backups_handler(ctx: Context<SetSeatBackups>, _index: u8, backups: [Pubkey; 2]) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let estate = &ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;

    let is_owner = authority == estate.owner && estate.status == EstateStatus::Active;
    let is_holder = is_set(&seat.holder) && authority == seat.holder;
    require!(is_owner || is_holder, HeirloomError::NotOwner);
    let backups = validate_backups(estate, backups)?;
    if seat.succession_pending() {
        let ts = now()?;
        require!(seat.report_stale(estate, &authority, ts), HeirloomError::SuccessionPending);
        seat.clear_succession();
        emit!(SeatDeathReportCleared { estate: seat.estate, seat_index: seat.index, ts });
    }

    seat.backups = backups;
    emit_seat_configured(seat)
}

// ====================================================================== set_seat_monitors

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct SetSeatMonitors<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn set_seat_monitors_handler(ctx: Context<SetSeatMonitors>, _index: u8, monitors: [Pubkey; 2]) -> Result<()> {
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );
    let seat = &mut ctx.accounts.seat;
    seat.monitors = validate_monitors(&seat.holder, monitors)?;
    emit_seat_configured(seat)
}

// ====================================================================== set_fallback

#[derive(Accounts)]
pub struct SetFallback<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump = guard.bump,
        has_one = estate
    )]
    pub guard: Account<'info, Guard>,
}

pub fn set_fallback_handler(ctx: Context<SetFallback>, recipients: [Pubkey; 4]) -> Result<()> {
    let estate = &ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    let guard = &mut ctx.accounts.guard;
    require!(!guard.fallback_done, HeirloomError::FallbackDone);

    for i in 0..FALLBACK_COUNT {
        if !is_set(&recipients[i]) {
            continue;
        }
        require!(recipients[i] != estate.owner, HeirloomError::BadFallback);
        for j in (i + 1)..FALLBACK_COUNT {
            require!(recipients[i] != recipients[j], HeirloomError::BadFallback);
        }
    }

    guard.fallback = recipients;
    guard.fallback_dead = 0;
    // The owner is alive and changing the plan: any started countdown is void.
    guard.fallback_started_at = 0;

    emit!(FallbackSet {
        estate: estate.key(),
        recipients,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== report_seat_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReportSeatDeath<'info> {
    /// A trusted person, the owner, this seat's backup or monitor, or an active beneficiary; never the holder.
    pub reporter: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,

    /// The reporter's Beneficiary PDA when a beneficiary reports; otherwise None.
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,
}

pub fn report_seat_death_handler(ctx: Context<ReportSeatDeath>, _index: u8, cert_hash: [u8; 32]) -> Result<()> {
    let reporter = ctx.accounts.reporter.key();
    let seat = &mut ctx.accounts.seat;
    require!(!seat.vacant && is_set(&seat.holder), HeirloomError::SeatVacant);
    require!(reporter != seat.holder, HeirloomError::BadStatus);
    require!(cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);
    let estate = &ctx.accounts.estate;
    let beneficiary = ctx.accounts.beneficiary_account.as_deref().map(|b| &**b);
    require!(
        is_participant(estate, &reporter, Some(&**seat), beneficiary)
            || (reporter != estate.agent && (reporter == estate.owner || seat.backups.contains(&reporter))),
        HeirloomError::NotParticipant
    );
    let ts = now()?;
    require!(!seat.succession_pending() || seat.report_stale(estate, &reporter, ts), HeirloomError::SuccessionPending);

    seat.death_cert_hash = cert_hash;
    seat.death_reported_by = reporter;
    seat.death_verdict = Verdict::Pending;
    seat.death_confirmed_by = Pubkey::default();
    seat.death_pending_since = ts;

    emit!(SeatDeathReported {
        estate: seat.estate,
        seat_index: seat.index,
        holder: seat.holder,
        reported_by: reporter,
        cert_hash,
        ts,
    });
    Ok(())
}

// ====================================================================== review_seat_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReviewSeatDeath<'info> {
    pub agent: Signer<'info>,

    #[account(has_one = agent @ HeirloomError::NotAgent)]
    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn review_seat_death_handler(
    ctx: Context<ReviewSeatDeath>,
    _index: u8,
    approve: bool,
    report_hash: [u8; 32],
    cert_hash: [u8; 32],
) -> Result<()> {
    let seat = &mut ctx.accounts.seat;
    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);
    require!(seat.death_verdict == Verdict::Pending, HeirloomError::BadStatus);
    require!(seat.death_cert_hash == cert_hash, HeirloomError::ReportChanged);

    if approve {
        seat.death_verdict = Verdict::Approved;
    } else {
        seat.clear_succession();
    }

    emit!(SeatDeathReviewed {
        estate: seat.estate,
        seat_index: seat.index,
        approved: approve,
        report_hash,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== confirm_seat_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ConfirmSeatDeath<'info> {
    /// Holder of another seat; if no other seat has a living holder: backups[1] or a monitor of this seat.
    pub confirmer: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn confirm_seat_death_handler(ctx: Context<ConfirmSeatDeath>, _index: u8) -> Result<()> {
    let confirmer = ctx.accounts.confirmer.key();
    let estate = &ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;
    let idx = seat.index as usize;

    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);
    require!(seat.death_verdict == Verdict::Approved, HeirloomError::AgentNotApproved);
    require!(!is_set(&seat.death_confirmed_by), HeirloomError::AlreadyApproved);
    // Nobody confirms a death they reported, their own death, or their own promotion; the agent only reviews.
    require!(
        confirmer != seat.death_reported_by
            && confirmer != seat.holder
            && confirmer != seat.backups[0]
            && confirmer != estate.agent,
        HeirloomError::NotConfirmer
    );

    let other_living: Vec<usize> = (0..VERIFIER_COUNT)
        .filter(|j| *j != idx && is_set(&estate.verifiers[*j]))
        .collect();
    let allowed = if other_living.is_empty() {
        (is_set(&seat.backups[1]) && confirmer == seat.backups[1]) || seat.is_monitor(&confirmer)
    } else {
        other_living.iter().any(|j| estate.verifiers[*j] == confirmer)
    };
    require!(allowed, HeirloomError::NotConfirmer);

    let ts = now()?;
    seat.death_confirmed_by = confirmer;
    seat.death_pending_since = ts;

    emit!(SeatDeathConfirmed {
        estate: seat.estate,
        seat_index: seat.index,
        confirmed_by: confirmer,
        ts,
    });
    Ok(())
}

// ====================================================================== veto_seat_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct VetoSeatDeath<'info> {
    /// The seat holder: "I'm still here".
    pub holder: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn veto_seat_death_handler(ctx: Context<VetoSeatDeath>, _index: u8) -> Result<()> {
    let holder = ctx.accounts.holder.key();
    let seat = &mut ctx.accounts.seat;
    require!(is_set(&seat.holder) && holder == seat.holder, HeirloomError::NotVerifier);
    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);

    seat.clear_succession();

    emit!(SeatDeathVetoed {
        estate: seat.estate,
        seat_index: seat.index,
        holder,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== finalize_succession

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct FinalizeSuccession<'info> {
    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    #[account(
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump = guard.bump,
        has_one = estate
    )]
    pub guard: Box<Account<'info, Guard>>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Box<Account<'info, Seat>>,

    /// CHECK: the ["objection", seat] PDA; may not exist. Blocks while Open.
    #[account(seeds = [OBJECTION_SEED, seat.key().as_ref()], bump)]
    pub objection: UncheckedAccount<'info>,

    /// Anyone (any wallet). A signer, so the call can be fee-sponsored (the sponsor is only the fee payer).
    pub caller: Signer<'info>,
}

pub fn finalize_succession_handler(ctx: Context<FinalizeSuccession>, _index: u8) -> Result<()> {
    let wait = ctx.accounts.guard.succession_wait();
    let objection_open = objection_is_open(&ctx.accounts.objection.to_account_info(), &ctx.accounts.estate)?;
    let estate = &mut ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;
    let idx = seat.index as usize;

    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);
    require!(seat.death_verdict == Verdict::Approved, HeirloomError::AgentNotApproved);
    require!(is_set(&seat.death_confirmed_by), HeirloomError::NotConfirmer);
    let ts = now()?;
    let ready_at = seat
        .death_pending_since
        .checked_add(wait)
        .ok_or(HeirloomError::MathOverflow)?;
    require!(ts >= ready_at, HeirloomError::WaitingPeriodNotOver);
    require!(!objection_open, HeirloomError::ObjectionOpen);

    // First backup that is still eligible: not the owner, the agent or already a holder, and not the
    // person who reported or confirmed this death (nobody promotes themselves).
    let mut eligible_next_time = false;
    let mut chosen: Option<usize> = None;
    for (i, b) in seat.backups.iter().enumerate() {
        if !is_set(b) || *b == estate.owner || *b == estate.agent || estate.verifier_index(b).is_some() {
            continue;
        }
        if *b == seat.death_confirmed_by || *b == seat.death_reported_by {
            eligible_next_time = true;
            continue;
        }
        chosen = Some(i);
        break;
    }
    // Only held back by this report: clear it, so someone else can report and the backup can take the seat.
    if chosen.is_none() && eligible_next_time {
        seat.clear_succession();
        emit!(SeatDeathReportCleared { estate: seat.estate, seat_index: seat.index, ts });
        return Ok(());
    }

    let previous_holder = seat.holder;
    seat.generation = seat.generation.checked_add(1).ok_or(HeirloomError::MathOverflow)?;
    match chosen {
        Some(i) => {
            let new_holder = seat.backups[i];
            seat.holder = new_holder;
            seat.backups = if i == 0 {
                [seat.backups[1], Pubkey::default()]
            } else {
                [Pubkey::default(); 2]
            };
            seat.monitors = without(seat.monitors, &new_holder);
            seat.vacant = false;
        }
        None => {
            // No backup could ever take this seat.
            seat.holder = Pubkey::default();
            seat.backups = [Pubkey::default(); 2];
            seat.vacant = true;
        }
    }
    seat.clear_succession();
    estate.verifiers[idx] = seat.holder;

    if seat.vacant {
        emit!(SeatVacated {
            estate: seat.estate,
            seat_index: seat.index,
            previous_holder,
            generation: seat.generation,
            ts,
        });
    } else {
        emit!(SuccessionFinalized {
            estate: seat.estate,
            seat_index: seat.index,
            previous_holder,
            new_holder: seat.holder,
            generation: seat.generation,
            ts,
        });
    }
    Ok(())
}

// ====================================================================== owner_replace_seat

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct OwnerReplaceSeat<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn owner_replace_seat_handler(ctx: Context<OwnerReplaceSeat>, _index: u8, new_holder: Pubkey) -> Result<()> {
    let estate = &mut ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    require!(
        is_set(&new_holder) && new_holder != estate.owner && estate.verifier_index(&new_holder).is_none(),
        HeirloomError::DuplicateVerifier
    );
    require!(new_holder != estate.agent, HeirloomError::BadAgent);

    seat.holder = new_holder;
    seat.backups = without(seat.backups, &new_holder);
    seat.monitors = without(seat.monitors, &new_holder);
    seat.vacant = false;
    seat.generation = seat.generation.checked_add(1).ok_or(HeirloomError::MathOverflow)?;
    seat.clear_succession();
    estate.verifiers[seat.index as usize] = new_holder;
    // Only the living owner can do this, and it revokes what the replaced person attested.
    record_proof_of_life(estate.key(), estate, now()?);
    emit_seat_configured(seat)
}

// ====================================================================== raise_objection

#[derive(Accounts)]
#[instruction(kind: TargetKind, target: Pubkey)]
pub struct RaiseObjection<'info> {
    /// A monitor (of `seat`), or for Fallback also an active beneficiary. Pays rent.
    #[account(mut)]
    pub objector: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(
        mut,
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump = guard.bump,
        has_one = estate
    )]
    pub guard: Box<Account<'info, Guard>>,

    /// The seat the objector monitors (required unless a beneficiary objects to the fallback).
    pub seat: Option<Box<Account<'info, Seat>>>,

    /// The objector's Beneficiary PDA (Fallback objections by a beneficiary only).
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,

    /// CHECK: the target account (Claim, Asset or Hardship); read and checked in the handler.
    /// Pass None for Unlock (target = estate), Succession (target = seat) and Fallback (target = guard).
    #[account(address = target)]
    pub target_account: Option<UncheckedAccount<'info>>,

    /// The hardship's Asset (Hardship objections only).
    pub asset: Option<Box<Account<'info, Asset>>>,

    #[account(
        init_if_needed,
        payer = objector,
        space = 8 + Objection::INIT_SPACE,
        seeds = [OBJECTION_SEED, target.as_ref()],
        bump
    )]
    pub objection: Box<Account<'info, Objection>>,

    pub system_program: Program<'info, System>,
}

pub fn raise_objection_handler(
    ctx: Context<RaiseObjection>,
    kind: TargetKind,
    target: Pubkey,
    seat_index: u8,
    reason_hash: [u8; 32],
) -> Result<()> {
    let objector = ctx.accounts.objector.key();
    let estate = &ctx.accounts.estate;
    let estate_key = estate.key();
    let guard_key = ctx.accounts.guard.key();

    // ---- who may object
    let seat = ctx.accounts.seat.as_ref();
    let seat_monitor = seat
        .map(|s| s.estate == estate_key && s.is_monitor(&objector))
        .unwrap_or(false);
    let stored_seat_index = match kind {
        TargetKind::Claim | TargetKind::Sale | TargetKind::Hardship | TargetKind::Succession => {
            require!(seat_monitor, HeirloomError::NotMonitor);
            require!(seat.unwrap().index == seat_index, HeirloomError::NotMonitor);
            seat_index
        }
        TargetKind::Unlock => {
            require!(seat_monitor, HeirloomError::NotMonitor);
            NO_SEAT
        }
        TargetKind::Fallback => {
            let beneficiary = ctx
                .accounts
                .beneficiary_account
                .as_ref()
                .map(|b| b.estate == estate_key && b.wallet == objector && b.active)
                .unwrap_or(false);
            require!(seat_monitor || beneficiary, HeirloomError::NotMonitor);
            NO_SEAT
        }
    };

    // ---- what may be objected to
    let target_info = ctx.accounts.target_account.as_ref().map(|a| a.to_account_info());
    match kind {
        TargetKind::Claim => {
            let info = target_info.clone().ok_or(HeirloomError::BadStatus)?;
            let claim: Claim = read_account(&info)?;
            require!(claim.estate == estate_key, HeirloomError::BadStatus);
            require!(claim.status == ClaimStatus::Open, HeirloomError::BadStatus);
            // Monitors object to approvals made by the holder they watch.
            require!(claim.approvals & (1u8 << seat_index) != 0, HeirloomError::BadStatus);
        }
        TargetKind::Unlock => {
            require_keys_eq!(target, estate_key, HeirloomError::BadStatus);
            require!(
                estate.status == EstateStatus::DeathPending
                    || (estate.status == EstateStatus::Active && estate.death_cert_hash != [0u8; 32]),
                HeirloomError::BadStatus
            );
        }
        TargetKind::Sale => {
            let info = target_info.clone().ok_or(HeirloomError::BadStatus)?;
            let asset: Asset = read_account(&info)?;
            require!(asset.estate == estate_key, HeirloomError::BadStatus);
            require!(asset.status == AssetStatus::Listed, HeirloomError::BadStatus);
        }
        TargetKind::Hardship => {
            let info = target_info.clone().ok_or(HeirloomError::BadStatus)?;
            let hardship: Hardship = read_account(&info)?;
            let asset = ctx.accounts.asset.as_ref().ok_or(HeirloomError::BadStatus)?;
            require_keys_eq!(asset.key(), hardship.asset, HeirloomError::BadStatus);
            require!(asset.estate == estate_key, HeirloomError::BadStatus);
            require!(asset.status != AssetStatus::Sold, HeirloomError::BadStatus);
            require!(
                hardship.status == HardshipStatus::Open || hardship.status == HardshipStatus::Approved,
                HeirloomError::BadStatus
            );
            require!(hardship.approvals & (1u8 << seat_index) != 0, HeirloomError::BadStatus);
        }
        TargetKind::Succession => {
            let s = seat.unwrap();
            require_keys_eq!(target, s.key(), HeirloomError::BadStatus);
            require!(s.succession_pending(), HeirloomError::NoSuccessionPending);
        }
        TargetKind::Fallback => {
            require_keys_eq!(target, guard_key, HeirloomError::BadStatus);
            let g = &ctx.accounts.guard;
            require!(!g.fallback_done, HeirloomError::FallbackDone);
            require!(countdown_valid(estate, g), HeirloomError::FallbackNotReady);
        }
    }

    // Otherwise whoever gains could use up the one objection and shut the others out.
    require!(
        objector != interested_party(kind, estate, &ctx.accounts.guard, target_info.as_ref())?,
        HeirloomError::OwnClaimDispute
    );

    // ---- one objection per target at a time; a resolved one may be re-raised (overwritten),
    // except a dismissed objection on a one-off claim or hardship.
    let ts = now()?;
    let objection = &mut ctx.accounts.objection;
    if is_set(&objection.target) {
        require!(!objection.is_effectively_open(estate, ts), HeirloomError::ObjectionOpen);
        // Still Open here means it lapsed, which counts as dismissed.
        let was_dispute = objection.is_dispute();
        let prev = if objection.status == ObjectionStatus::Open {
            if !was_dispute {
                let guard = &mut ctx.accounts.guard;
                guard.open_objections = guard.open_objections.saturating_sub(1);
            }
            ObjectionStatus::Dismissed
        } else {
            objection.status
        };
        // A finished dispute never uses up the monitors' objection. A monitors' objection that was dismissed
        // does: once per claim, hardship and waiting period; with a cooldown for sales and successions.
        if prev == ObjectionStatus::Dismissed && !was_dispute {
            match kind {
                // One dismissed before this death challenged approvals that no longer count.
                TargetKind::Claim => require!(
                    estate.status == EstateStatus::Unlocked && objection.raised_at < estate.death_pending_since,
                    HeirloomError::BadStatus
                ),
                TargetKind::Hardship => return err!(HeirloomError::BadStatus),
                TargetKind::Unlock => require!(
                    objection.raised_at < estate.death_pending_since,
                    HeirloomError::BadStatus
                ),
                TargetKind::Sale | TargetKind::Succession => require!(
                    ts >= objection.reraise_at(estate),
                    HeirloomError::ObjectionCooldown
                ),
                TargetKind::Fallback => {}
            }
        }
        // One fallback objection per countdown: a dismissed or lapsed one can't be re-raised until the
        // countdown restarts (upheld objection, new recipient), or objections could delay it forever.
        require!(
            !(kind == TargetKind::Fallback
                && prev == ObjectionStatus::Dismissed
                && objection.raised_at >= ctx.accounts.guard.fallback_started_at),
            HeirloomError::BadStatus
        );
    }

    let bump = ctx.bumps.objection;
    objection.set_inner(Objection {
        estate: estate_key,
        target,
        kind,
        monitor: objector,
        seat_index: stored_seat_index,
        reason_hash,
        raised_at: ts,
        status: ObjectionStatus::Open,
        votes_uphold: 0,
        votes_dismiss: 0,
        bump,
    });
    let guard = &mut ctx.accounts.guard;
    guard.open_objections = guard
        .open_objections
        .checked_add(1)
        .ok_or(HeirloomError::MathOverflow)?;

    emit!(ObjectionRaised {
        estate: estate_key,
        objection: ctx.accounts.objection.key(),
        target,
        kind,
        monitor: objector,
        seat_index: stored_seat_index,
        reason_hash,
        ts,
    });
    Ok(())
}

// ====================================================================== vote_objection

#[derive(Accounts)]
pub struct VoteObjection<'info> {
    /// A seat holder other than the watched holder and the objector, or the owner while Active
    /// (decides alone). Fallback objections: a monitor other than the objector (one vote, however many seats
    /// they watch).
    pub voter: Signer<'info>,

    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    #[account(
        mut,
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump = guard.bump,
        has_one = estate
    )]
    pub guard: Box<Account<'info, Guard>>,

    #[account(
        mut,
        seeds = [OBJECTION_SEED, objection.target.as_ref()],
        bump = objection.bump,
        has_one = estate
    )]
    pub objection: Box<Account<'info, Objection>>,

    /// CHECK: == objection.target. Needed (writable) for Claim, Sale, Hardship and Succession;
    /// None for Unlock (the estate) and Fallback (the guard).
    #[account(mut, address = objection.target)]
    pub target_account: Option<UncheckedAccount<'info>>,

    /// The hardship's Asset (Hardship objections only; its hardship floor is withdrawn if upheld).
    #[account(mut)]
    pub asset: Option<Box<Account<'info, Asset>>>,
    // remaining_accounts (Fallback votes by a monitor): the three Seat PDAs, in index order.
}

/// Bitmap of every position (2i + j) at which `who` monitors. All three seats are needed, so that one wallet
/// watching several seats still has one vote.
fn monitor_positions(infos: &[AccountInfo], estate: &Pubkey, who: &Pubkey) -> Result<u8> {
    require!(infos.len() == VERIFIER_COUNT, HeirloomError::NotMonitor);
    let mut positions = 0u8;
    for (i, info) in infos.iter().enumerate() {
        let seat: Seat = read_account(info)?;
        let expected = Pubkey::create_program_address(&[SEAT_SEED, estate.as_ref(), &[i as u8], &[seat.bump]], &crate::ID)
            .map_err(|_| error!(HeirloomError::BadStatus))?;
        require_keys_eq!(info.key(), expected, HeirloomError::BadStatus);
        for (j, monitor) in seat.monitors.iter().enumerate() {
            if is_set(monitor) && monitor == who {
                positions |= 1u8 << (i * 2 + j);
            }
        }
    }
    Ok(positions)
}

pub fn vote_objection_handler<'info>(ctx: Context<'info, VoteObjection<'info>>, uphold: bool) -> Result<()> {
    let voter = ctx.accounts.voter.key();
    let estate_key = ctx.accounts.estate.key();
    let objection = &mut ctx.accounts.objection;
    require!(objection.status == ObjectionStatus::Open, HeirloomError::BadStatus);
    // Disputes are resolved by the verifiers with resolve_dispute.
    require!(!objection.is_dispute(), HeirloomError::BadStatus);
    let kind = objection.kind;
    require!(
        !fallback_objection_lapsed(objection, &ctx.accounts.estate, ctx.accounts.guard.fallback_wait(), now()?)?,
        HeirloomError::ObjectionLapsed
    );

    require!(
        kind == TargetKind::Fallback || objection.is_effectively_open(&ctx.accounts.estate, now()?),
        HeirloomError::ObjectionLapsed
    );
    let estate = &ctx.accounts.estate;
    let owner_decides = voter == estate.owner && estate.status == EstateStatus::Active;
    let decision: Option<bool> = if owner_decides {
        Some(uphold)
    } else {
        require!(voter != objection.monitor, HeirloomError::NotVerifier);
        // `bit` is recorded; a vote at any of the voter's `positions` means they have voted.
        let (bit, positions) = if kind == TargetKind::Fallback {
            let positions = monitor_positions(ctx.remaining_accounts, &estate_key, &voter)?;
            require!(positions != 0, HeirloomError::NotMonitor);
            (1u8 << positions.trailing_zeros(), positions)
        } else {
            let idx = estate.verifier_index(&voter).ok_or(HeirloomError::NotVerifier)?;
            require!(objection.seat_index as usize != idx, HeirloomError::NotVerifier);
            (1u8 << idx, 1u8 << idx)
        };
        require!(
            (objection.votes_uphold | objection.votes_dismiss) & positions == 0,
            HeirloomError::AlreadyApproved
        );
        if uphold {
            objection.votes_uphold |= bit;
        } else {
            let info = ctx.accounts.target_account.as_ref().map(|a| a.to_account_info());
            require!(
                voter != interested_party(kind, estate, &ctx.accounts.guard, info.as_ref())?,
                HeirloomError::OwnApproval
            );
            objection.votes_dismiss |= bit;
        }
        // Monitors' bits are positions, not seats: the holders are all gone by then.
        let voting = if kind == TargetKind::Fallback { u8::MAX } else { estate.living_seats_except(&Pubkey::default()) };
        if count_bits(objection.votes_uphold & voting) >= 2 {
            Some(true)
        } else if count_bits(objection.votes_dismiss & voting) >= 2 {
            Some(false)
        } else {
            None
        }
    };

    let ts = now()?;
    let objection_key = objection.key();
    let target = objection.target;
    emit!(ObjectionVoted {
        objection: objection_key,
        voter,
        uphold,
        ts,
    });

    let Some(upheld) = decision else {
        return Ok(());
    };
    objection.status = if upheld {
        ObjectionStatus::Upheld
    } else {
        ObjectionStatus::Dismissed
    };
    let guard = &mut ctx.accounts.guard;
    guard.open_objections = guard.open_objections.saturating_sub(1);

    if upheld {
        let target_info = ctx.accounts.target_account.as_ref().map(|a| a.to_account_info());
        match kind {
            TargetKind::Claim => uphold_on_claim(&target_info.ok_or(HeirloomError::BadStatus)?)?,
            TargetKind::Unlock => uphold_on_unlock(&mut ctx.accounts.estate),
            TargetKind::Sale => {
                // The listing is cancelled; offers can only be accepted after a fresh list_asset.
                let info = target_info.ok_or(HeirloomError::BadStatus)?;
                let mut asset: Asset = read_account(&info)?;
                if asset.status == AssetStatus::Listed {
                    asset.status = AssetStatus::Held;
                    write_account(&info, &asset)?;
                }
            }
            TargetKind::Hardship => {
                let info = target_info.ok_or(HeirloomError::BadStatus)?;
                let mut hardship: Hardship = read_account(&info)?;
                let asset = ctx.accounts.asset.as_mut().ok_or(HeirloomError::BadStatus)?;
                require_keys_eq!(asset.key(), hardship.asset, HeirloomError::BadStatus);
                if asset.hardship_beneficiary == Some(hardship.beneficiary) {
                    asset.hardship_beneficiary = None;
                }
                hardship.status = HardshipStatus::Rejected;
                write_account(&info, &hardship)?;
            }
            TargetKind::Succession => {
                let info = target_info.ok_or(HeirloomError::BadStatus)?;
                let mut seat: Seat = read_account(&info)?;
                seat.clear_succession();
                write_account(&info, &seat)?;
            }
            TargetKind::Fallback => {
                guard.fallback_started_at = 0;
            }
        }
    }

    emit!(ObjectionResolved {
        estate: estate_key,
        objection: objection_key,
        target,
        kind,
        upheld,
        ts,
    });
    Ok(())
}

// ====================================================================== set_asset_media

#[derive(Accounts)]
pub struct SetAssetMedia<'info> {
    /// The owner (estate Active) or the agent. Pays rent the first time.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(has_one = estate)]
    pub asset: Account<'info, Asset>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + AssetMedia::INIT_SPACE,
        seeds = [MEDIA_SEED, asset.key().as_ref()],
        bump
    )]
    pub media: Account<'info, AssetMedia>,

    pub system_program: Program<'info, System>,
}

pub fn set_asset_media_handler(
    ctx: Context<SetAssetMedia>,
    kind: AssetKind,
    photos_root: [u8; 32],
    photo_count: u8,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let estate = &ctx.accounts.estate;
    let is_owner = authority == estate.owner && estate.status == EstateStatus::Active;
    require!(is_owner || authority == estate.agent, HeirloomError::NotOwner);
    require!(photo_count <= MAX_PHOTOS, HeirloomError::InvalidAmount);

    let ts = now()?;
    let asset = ctx.accounts.asset.key();
    let bump = ctx.bumps.media;
    ctx.accounts.media.set_inner(AssetMedia {
        asset,
        kind,
        photos_root,
        photo_count,
        updated_at: ts,
        bump,
    });

    emit!(AssetMediaSet {
        asset,
        kind,
        photos_root,
        photo_count,
        ts,
    });
    Ok(())
}

// ====================================================================== report / review fallback death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReportFallbackDeath<'info> {
    /// A living trusted person, monitor, active beneficiary or listed recipient. Pays the report's rent.
    #[account(mut)]
    pub reporter: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Box<Account<'info, Guard>>,

    #[account(
        init_if_needed,
        payer = reporter,
        space = 8 + FallbackReport::INIT_SPACE,
        seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[index]],
        bump
    )]
    pub fallback_report: Box<Account<'info, FallbackReport>>,

    /// A seat the reporter monitors; otherwise None.
    pub signer_seat: Option<Box<Account<'info, Seat>>>,

    /// The reporter's Beneficiary PDA; otherwise None.
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,

    pub system_program: Program<'info, System>,
}

pub fn report_fallback_death_handler(
    ctx: Context<ReportFallbackDeath>,
    index: u8,
    cert_hash: [u8; 32],
) -> Result<()> {
    let reporter = ctx.accounts.reporter.key();
    let estate = &ctx.accounts.estate;
    let guard = &ctx.accounts.guard;
    let i = index as usize;
    require!(i < FALLBACK_COUNT, HeirloomError::InvalidAmount);
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    let recipient = guard.fallback[i];
    require!(is_set(&recipient), HeirloomError::NoFallbackRecipient);
    require!(guard.is_living_recipient(i), HeirloomError::BadStatus);
    require!(cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);
    let seat = ctx.accounts.signer_seat.as_deref().map(|s| &**s);
    let beneficiary = ctx.accounts.beneficiary_account.as_deref().map(|b| &**b);
    require!(
        reporter != recipient && is_fallback_participant(estate, guard, &reporter, seat, beneficiary),
        HeirloomError::NotParticipant
    );

    let ts = now()?;
    let report = &mut ctx.accounts.fallback_report;
    if !is_set(&report.estate) {
        report.estate = estate.key();
        report.index = index;
        report.rent_payer = reporter;
        report.bump = ctx.bumps.fallback_report;
    } else if report.recipient == recipient {
        let hold = guard.refute_wait().saturating_mul(2);
        require!(
            estate.report_replaceable(report.verdict, report.reported_at, &report.reporter, &reporter, hold, ts),
            HeirloomError::BadStatus
        );
    }
    report.recipient = recipient;
    report.reporter = reporter;
    report.cert_hash = cert_hash;
    report.verdict = Verdict::Pending;
    report.reported_at = ts;

    emit!(FallbackDeathReported {
        estate: guard.estate,
        index,
        recipient,
        reported_by: reporter,
        cert_hash,
        ts,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReviewFallbackDeath<'info> {
    pub agent: Signer<'info>,

    #[account(has_one = agent @ HeirloomError::NotAgent)]
    pub estate: Account<'info, Estate>,

    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Account<'info, Guard>,

    #[account(
        mut,
        seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[index]],
        bump = fallback_report.bump,
        has_one = estate
    )]
    pub fallback_report: Account<'info, FallbackReport>,

    /// CHECK: == fallback_report.rent_payer; gets the rent back if the report is rejected.
    #[account(mut, address = fallback_report.rent_payer)]
    pub rent_to: UncheckedAccount<'info>,
}

/// The agent only sets the report's verdict; a rejection closes it.
pub fn review_fallback_death_handler(
    ctx: Context<ReviewFallbackDeath>,
    index: u8,
    approve: bool,
    report_hash: [u8; 32],
    cert_hash: [u8; 32],
) -> Result<()> {
    let guard = &ctx.accounts.guard;
    let i = index as usize;
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    require!(guard.is_living_recipient(i), HeirloomError::BadStatus);
    let report = &mut ctx.accounts.fallback_report;
    require!(report.recipient == guard.fallback[i], HeirloomError::NoFallbackRecipient);
    require!(report.verdict == Verdict::Pending, HeirloomError::BadStatus);
    require!(report.cert_hash == cert_hash, HeirloomError::ReportChanged);

    if approve {
        report.verdict = Verdict::Approved;
    } else {
        close_program_account(&report.to_account_info(), &ctx.accounts.rent_to.to_account_info())?;
    }

    emit!(FallbackDeathReviewed {
        estate: guard.estate,
        index,
        approved: approve,
        report_hash,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== resolve_fallback_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ResolveFallbackDeath<'info> {
    /// `dead`: a second participant. Otherwise the reported recipient ("I'm alive").
    pub signer: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Box<Account<'info, Guard>>,

    #[account(
        mut,
        seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[index]],
        bump = fallback_report.bump,
        has_one = estate
    )]
    pub fallback_report: Box<Account<'info, FallbackReport>>,

    /// CHECK: == fallback_report.rent_payer; gets the report's rent back.
    #[account(mut, address = fallback_report.rent_payer)]
    pub rent_to: UncheckedAccount<'info>,

    /// A seat the signer monitors; otherwise None.
    pub signer_seat: Option<Box<Account<'info, Seat>>>,

    /// The signer's Beneficiary PDA; otherwise None.
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,
}

/// `dead`: a second person confirms, after the fallback wait from the report. Otherwise the recipient refutes,
/// at any time before that. Either way the report closes.
pub fn resolve_fallback_death_handler(ctx: Context<ResolveFallbackDeath>, index: u8, dead: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let estate = &ctx.accounts.estate;
    let report = &ctx.accounts.fallback_report;
    let guard = &mut ctx.accounts.guard;
    let (estate_key, recipient, ts) = (estate.key(), report.recipient, now()?);

    if !dead {
        require!(signer == recipient, HeirloomError::NotParticipant);
        close_program_account(&report.to_account_info(), &ctx.accounts.rent_to.to_account_info())?;
        emit!(FallbackDeathRefuted { estate: estate_key, index, recipient, ts });
        return Ok(());
    }

    let i = index as usize;
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    require!(guard.is_living_recipient(i), HeirloomError::BadStatus);
    require!(recipient == guard.fallback[i], HeirloomError::NoFallbackRecipient);
    require!(report.verdict == Verdict::Approved, HeirloomError::AgentNotApproved);
    let would_gain = guard.living_recipient_from(i + 1).map(|n| guard.fallback[n]).unwrap_or_default();
    let seat = ctx.accounts.signer_seat.as_deref().map(|s| &**s);
    let beneficiary = ctx.accounts.beneficiary_account.as_deref().map(|b| &**b);
    require!(
        signer != recipient
            && signer != report.reporter
            && signer != would_gain
            && is_fallback_participant(estate, guard, &signer, seat, beneficiary),
        HeirloomError::NotConfirmer
    );
    let confirmable_at = report.reported_at.saturating_add(guard.refute_wait());
    require!(ts >= confirmable_at, HeirloomError::WaitingPeriodNotOver);

    let running = countdown_valid(estate, guard);
    guard.fallback_dead |= 1u8 << i;
    // The recipient changed: restart a running countdown so family can object to the new one.
    if running {
        guard.fallback_started_at = ts;
    }
    close_program_account(&report.to_account_info(), &ctx.accounts.rent_to.to_account_info())?;

    emit!(FallbackDeathConfirmed { estate: estate_key, index, recipient, confirmed_by: signer, ts });
    Ok(())
}

// ====================================================================== start_fallback / execute_fallback

fn all_vacant(seats: [&Seat; 3]) -> bool {
    seats.iter().all(|s| s.vacant && !is_set(&s.holder))
}

#[derive(Accounts)]
pub struct StartFallback<'info> {
    pub estate: Box<Account<'info, Estate>>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Box<Account<'info, Guard>>,

    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[0u8]], bump = seat0.bump)]
    pub seat0: Box<Account<'info, Seat>>,
    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[1u8]], bump = seat1.bump)]
    pub seat1: Box<Account<'info, Seat>>,
    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[2u8]], bump = seat2.bump)]
    pub seat2: Box<Account<'info, Seat>>,

    /// Anyone (any wallet). A signer, so the call can be fee-sponsored (the sponsor is only the fee payer).
    pub caller: Signer<'info>,
}

pub fn start_fallback_handler(ctx: Context<StartFallback>) -> Result<()> {
    let estate = &ctx.accounts.estate;
    let guard = &mut ctx.accounts.guard;
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    // Not started, or a start the owner has since disproved, or one made for an earlier death claim.
    require!(!countdown_valid(estate, guard), HeirloomError::BadStatus);
    require!(
        all_vacant([&ctx.accounts.seat0, &ctx.accounts.seat1, &ctx.accounts.seat2]),
        HeirloomError::SeatsNotVacant
    );
    require!(owner_death_established(estate), HeirloomError::FallbackNotReady);
    require!(
        is_set(&guard.next_fallback_recipient()),
        HeirloomError::NoFallbackRecipient
    );

    let ts = now()?;
    guard.fallback_started_at = ts;
    let runs_at = ts
        .checked_add(fallback_delay(estate, guard))
        .ok_or(HeirloomError::MathOverflow)?;

    emit!(FallbackStarted {
        estate: estate.key(),
        runs_at,
        ts,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteFallback<'info> {
    /// Anyone; pays the recipient's ATA rent if missing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Box<Account<'info, Guard>>,

    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[0u8]], bump = seat0.bump)]
    pub seat0: Box<Account<'info, Seat>>,
    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[1u8]], bump = seat1.bump)]
    pub seat1: Box<Account<'info, Seat>>,
    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[2u8]], bump = seat2.bump)]
    pub seat2: Box<Account<'info, Seat>>,

    /// CHECK: the ["objection", guard] PDA; may not exist. Blocks while Open, unless it has lapsed
    /// (then it is marked Dismissed here, so it is writable).
    #[account(mut, seeds = [OBJECTION_SEED, guard.key().as_ref()], bump)]
    pub objection: UncheckedAccount<'info>,

    /// CHECK: must be the first fallback recipient not proven dead.
    #[account(constraint = recipient.key() == guard.next_fallback_recipient() @ HeirloomError::NoFallbackRecipient)]
    pub recipient: UncheckedAccount<'info>,

    #[account(address = estate.usdt_mint @ HeirloomError::WrongMint)]
    pub usdt_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = usdt_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdt_mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_usdt: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: the ["fallbackreport", estate, [index of the recipient]] PDA; may not exist. An agent-approved
    /// report made during the countdown holds the payment until it can be confirmed or refuted.
    #[account(seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[guard.next_fallback_index()]], bump)]
    pub fallback_report: UncheckedAccount<'info>,
}

pub fn execute_fallback_handler(ctx: Context<ExecuteFallback>) -> Result<()> {
    let ts = now()?;
    let wait = ctx.accounts.guard.fallback_wait();
    let obj_info = ctx.accounts.objection.to_account_info();
    let mut lapsed: Option<Objection> = None;
    let objection_open = if account_exists(&obj_info) {
        let mut o: Objection = read_account(&obj_info)?;
        if fallback_objection_lapsed(&o, &ctx.accounts.estate, wait, ts)? {
            o.status = ObjectionStatus::Dismissed;
            write_account(&obj_info, &o)?;
            lapsed = Some(o);
            false
        } else {
            o.status == ObjectionStatus::Open
        }
    } else {
        false
    };
    if let Some(o) = lapsed {
        let guard = &mut ctx.accounts.guard;
        guard.open_objections = guard.open_objections.saturating_sub(1);
        emit!(ObjectionResolved {
            estate: o.estate,
            objection: obj_info.key(),
            target: o.target,
            kind: o.kind,
            upheld: false,
            ts,
        });
    }
    let estate = &ctx.accounts.estate;
    let guard = &ctx.accounts.guard;

    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    // Not started, void after the owner's sign of life, or made for an earlier death claim.
    require!(countdown_valid(estate, guard), HeirloomError::FallbackNotReady);
    require!(owner_death_established(estate), HeirloomError::FallbackNotReady);
    require!(
        all_vacant([&ctx.accounts.seat0, &ctx.accounts.seat1, &ctx.accounts.seat2]),
        HeirloomError::SeatsNotVacant
    );
    let runs_at = guard
        .fallback_started_at
        .checked_add(fallback_delay(estate, guard))
        .ok_or(HeirloomError::MathOverflow)?;
    require!(ts >= runs_at, HeirloomError::WaitingPeriodNotOver);
    require!(!objection_open, HeirloomError::ObjectionOpen);
    let recipient = guard.next_fallback_recipient();
    require!(is_set(&recipient), HeirloomError::NoFallbackRecipient);
    // Without this a death reported after the start could never be confirmed in time. Only reports from
    // before the countdown ended hold it, so the hold can't be renewed for ever.
    let report_info = ctx.accounts.fallback_report.to_account_info();
    if account_exists(&report_info) {
        let r: FallbackReport = read_account(&report_info)?;
        let holds = r.recipient == recipient
            && r.verdict == Verdict::Approved
            && r.reported_at < runs_at
            && ts < r.reported_at.saturating_add(guard.refute_wait().saturating_mul(2));
        require!(!holds, HeirloomError::DeathReportOpen);
    }

    let amount = ctx.accounts.vault.amount;
    if amount > 0 {
        let owner = estate.owner;
        let bump = [estate.bump];
        let seeds: &[&[u8]] = &[ESTATE_SEED, owner.as_ref(), &bump];
        transfer_checked_cpi(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.usdt_mint.to_account_info(),
            ctx.accounts.recipient_usdt.to_account_info(),
            ctx.accounts.estate.to_account_info(),
            amount,
            ctx.accounts.usdt_mint.decimals,
            &[seeds],
        )?;
    }

    ctx.accounts.guard.fallback_done = true;
    let estate = &mut ctx.accounts.estate;
    // From submission time to the time the death took effect.
    if estate.status == EstateStatus::Active {
        estate.death_pending_since = ts;
    }
    estate.status = EstateStatus::Unlocked;

    emit!(FallbackExecuted {
        estate: ctx.accounts.estate.key(),
        recipient,
        amount,
        ts,
    });
    Ok(())
}

// ====================================================================== lapse_objection

#[derive(Accounts)]
pub struct LapseObjection<'info> {
    pub estate: Account<'info, Estate>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Account<'info, Guard>,

    #[account(
        mut,
        seeds = [OBJECTION_SEED, objection.target.as_ref()],
        bump = objection.bump,
        has_one = estate
    )]
    pub objection: Account<'info, Objection>,

    /// Anyone (any wallet). A signer, so the call can be fee-sponsored (the sponsor is only the fee payer).
    pub caller: Signer<'info>,
}

/// Anyone: marks a lapsed monitors' objection Dismissed. Fallback objections lapse after the fallback wait,
/// the others after two of the estate's waiting periods. The fallback countdown is not restarted (it kept running during the objection).
pub fn lapse_objection_handler(ctx: Context<LapseObjection>) -> Result<()> {
    let objection = &mut ctx.accounts.objection;
    require!(!objection.is_dispute(), HeirloomError::BadStatus);
    require!(objection.status == ObjectionStatus::Open, HeirloomError::BadStatus);
    let ts = now()?;
    let lapsed = if objection.kind == TargetKind::Fallback {
        fallback_objection_lapsed(objection, &ctx.accounts.estate, ctx.accounts.guard.fallback_wait(), ts)?
    } else {
        !objection.is_effectively_open(&ctx.accounts.estate, ts)
    };
    require!(lapsed, HeirloomError::ObjectionNotLapsed);

    objection.status = ObjectionStatus::Dismissed;
    let guard = &mut ctx.accounts.guard;
    guard.open_objections = guard.open_objections.saturating_sub(1);

    emit!(ObjectionResolved {
        estate: objection.estate,
        objection: objection.key(),
        target: objection.target,
        kind: objection.kind,
        upheld: false,
        ts,
    });
    Ok(())
}
