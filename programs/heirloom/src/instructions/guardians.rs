//! Guardians: seats (trusted people) with backups and monitors, succession when a holder dies,
//! monitor objections, the fallback plan and asset photo hashes.
//! Spec: docs/guardians-spec.md §2 and docs/program-spec.md ("Guardians").
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::{
    account_exists, count_bits, now, objection_is_open, read_account, transfer_checked_cpi, write_account,
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

/// Backups must differ from the owner, from every current holder (this one included) and each other.
fn validate_backups(estate: &Estate, backups: [Pubkey; 2]) -> Result<[Pubkey; 2]> {
    let b = compact_pair(backups).ok_or(HeirloomError::BadBackup)?;
    for k in b.iter().filter(|k| is_set(k)) {
        require!(*k != estate.owner, HeirloomError::BadBackup);
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

/// Drops `key` from a pair and compacts it.
fn without(pair: [Pubkey; 2], key: &Pubkey) -> [Pubkey; 2] {
    let p = pair.map(|k| if k == *key { Pubkey::default() } else { k });
    if is_set(&p[0]) { p } else { [p[1], Pubkey::default()] }
}

/// The owner's death is established for the fallback: estate Unlocked, or the agent approved the death claim.
fn owner_death_established(estate: &Estate) -> bool {
    estate.status == EstateStatus::Unlocked || estate.death_verdict == Verdict::Approved
}

/// An Open Fallback objection lapses (counts as Dismissed) once `fallback_wait_secs` have passed since it
/// was raised without it being upheld, so a missing or tied vote can never lock the vault forever.
fn fallback_objection_lapsed(o: &Objection, wait: i64, ts: i64) -> Result<bool> {
    if o.kind != TargetKind::Fallback || o.status != ObjectionStatus::Open {
        return Ok(false);
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
    require!(!seat.succession_pending(), HeirloomError::SuccessionPending);

    seat.backups = validate_backups(estate, backups)?;
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
    /// Anyone except the holder.
    pub reporter: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn report_seat_death_handler(ctx: Context<ReportSeatDeath>, _index: u8, cert_hash: [u8; 32]) -> Result<()> {
    let reporter = ctx.accounts.reporter.key();
    let seat = &mut ctx.accounts.seat;
    require!(!seat.vacant && is_set(&seat.holder), HeirloomError::SeatVacant);
    require!(reporter != seat.holder, HeirloomError::BadStatus);
    require!(cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);
    require!(!seat.succession_pending(), HeirloomError::SuccessionPending);

    seat.death_cert_hash = cert_hash;
    seat.death_reported_by = reporter;
    seat.death_verdict = Verdict::Pending;
    seat.death_confirmed_by = Pubkey::default();
    seat.death_pending_since = 0;

    emit!(SeatDeathReported {
        estate: seat.estate,
        seat_index: seat.index,
        holder: seat.holder,
        reported_by: reporter,
        cert_hash,
        ts: now()?,
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
) -> Result<()> {
    let seat = &mut ctx.accounts.seat;
    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);
    require!(seat.death_verdict == Verdict::Pending, HeirloomError::BadStatus);

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
    // Nobody confirms a death they reported, their own death, or their own promotion.
    require!(
        confirmer != seat.death_reported_by && confirmer != seat.holder && confirmer != seat.backups[0],
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

    // First backup that is still eligible: not the owner, not already a holder, and not the
    // person who reported or confirmed this death (nobody promotes themselves).
    let mut any_backup = false;
    let mut chosen: Option<usize> = None;
    for (i, b) in seat.backups.iter().enumerate() {
        if !is_set(b) {
            continue;
        }
        any_backup = true;
        if *b == estate.owner
            || estate.verifier_index(b).is_some()
            || *b == seat.death_confirmed_by
            || *b == seat.death_reported_by
        {
            continue;
        }
        chosen = Some(i);
        break;
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
            // Backups exist but none is eligible: leave the succession pending rather than vacate
            // the seat (an upheld objection, the owner, or a fresh report sorts it out).
            require!(!any_backup, HeirloomError::BadBackup);
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

    seat.holder = new_holder;
    seat.backups = without(seat.backups, &new_holder);
    seat.monitors = without(seat.monitors, &new_holder);
    seat.vacant = false;
    seat.generation = seat.generation.checked_add(1).ok_or(HeirloomError::MathOverflow)?;
    seat.clear_succession();
    estate.verifiers[seat.index as usize] = new_holder;
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
            let info = target_info.ok_or(HeirloomError::BadStatus)?;
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
            let info = target_info.ok_or(HeirloomError::BadStatus)?;
            let asset: Asset = read_account(&info)?;
            require!(asset.estate == estate_key, HeirloomError::BadStatus);
            require!(asset.status == AssetStatus::Listed, HeirloomError::BadStatus);
        }
        TargetKind::Hardship => {
            let info = target_info.ok_or(HeirloomError::BadStatus)?;
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
            require!(g.fallback_started_at != 0, HeirloomError::FallbackNotReady);
        }
    }

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
                TargetKind::Claim | TargetKind::Hardship => return err!(HeirloomError::BadStatus),
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
    /// (decides alone). Fallback objections: a monitor of `voter_seat` other than the objector.
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

    /// The seat the voter monitors (Fallback objections only).
    pub voter_seat: Option<Box<Account<'info, Seat>>>,

    /// CHECK: == objection.target. Needed (writable) for Claim, Sale, Hardship and Succession;
    /// None for Unlock (the estate) and Fallback (the guard).
    #[account(mut, address = objection.target)]
    pub target_account: Option<UncheckedAccount<'info>>,

    /// The hardship's Asset (Hardship objections only; its hardship floor is withdrawn if upheld).
    #[account(mut)]
    pub asset: Option<Box<Account<'info, Asset>>>,
}

pub fn vote_objection_handler(ctx: Context<VoteObjection>, uphold: bool) -> Result<()> {
    let voter = ctx.accounts.voter.key();
    let estate_key = ctx.accounts.estate.key();
    let objection = &mut ctx.accounts.objection;
    require!(objection.status == ObjectionStatus::Open, HeirloomError::BadStatus);
    // Disputes are resolved by the verifiers with resolve_dispute.
    require!(!objection.is_dispute(), HeirloomError::BadStatus);
    let kind = objection.kind;
    require!(
        !fallback_objection_lapsed(objection, ctx.accounts.guard.fallback_wait(), now()?)?,
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
        let bit: u8 = if kind == TargetKind::Fallback {
            let s = ctx.accounts.voter_seat.as_ref().ok_or(HeirloomError::NotMonitor)?;
            require!(s.estate == estate_key, HeirloomError::NotMonitor);
            let j = s
                .monitors
                .iter()
                .position(|m| is_set(m) && *m == voter)
                .ok_or(HeirloomError::NotMonitor)?;
            1u8 << (s.index as u32 * 2 + j as u32)
        } else {
            let idx = estate.verifier_index(&voter).ok_or(HeirloomError::NotVerifier)?;
            require!(objection.seat_index as usize != idx, HeirloomError::NotVerifier);
            1u8 << idx
        };
        require!(
            (objection.votes_uphold | objection.votes_dismiss) & bit == 0,
            HeirloomError::AlreadyApproved
        );
        if uphold {
            objection.votes_uphold |= bit;
        } else {
            objection.votes_dismiss |= bit;
        }
        if count_bits(objection.votes_uphold) >= 2 {
            Some(true)
        } else if count_bits(objection.votes_dismiss) >= 2 {
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
pub struct ReportFallbackDeath<'info> {
    pub reporter: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Account<'info, Guard>,
}

pub fn report_fallback_death_handler(
    ctx: Context<ReportFallbackDeath>,
    index: u8,
    cert_hash: [u8; 32],
) -> Result<()> {
    let guard = &ctx.accounts.guard;
    let i = index as usize;
    require!(i < FALLBACK_COUNT, HeirloomError::InvalidAmount);
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    require!(is_set(&guard.fallback[i]), HeirloomError::NoFallbackRecipient);
    require!(guard.fallback_dead & (1u8 << i) == 0, HeirloomError::BadStatus);
    require!(cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);

    emit!(FallbackDeathReported {
        estate: guard.estate,
        index,
        recipient: guard.fallback[i],
        reported_by: ctx.accounts.reporter.key(),
        cert_hash,
        ts: now()?,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ReviewFallbackDeath<'info> {
    pub agent: Signer<'info>,

    #[account(has_one = agent @ HeirloomError::NotAgent)]
    pub estate: Account<'info, Estate>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Account<'info, Guard>,
}

pub fn review_fallback_death_handler(
    ctx: Context<ReviewFallbackDeath>,
    index: u8,
    approve: bool,
    report_hash: [u8; 32],
) -> Result<()> {
    let guard = &mut ctx.accounts.guard;
    let i = index as usize;
    require!(i < FALLBACK_COUNT, HeirloomError::InvalidAmount);
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    require!(is_set(&guard.fallback[i]), HeirloomError::NoFallbackRecipient);
    require!(guard.fallback_dead & (1u8 << i) == 0, HeirloomError::BadStatus);

    let ts = now()?;
    if approve {
        guard.fallback_dead |= 1u8 << i;
        // The recipient changed: restart the countdown so family can object to the new one.
        if guard.fallback_started_at != 0 {
            guard.fallback_started_at = ts;
        }
    }

    emit!(FallbackDeathReviewed {
        estate: guard.estate,
        index,
        approved: approve,
        report_hash,
        ts,
    });
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
    // Not started, or a start the owner has since disproved by a heartbeat / veto.
    require!(
        guard.fallback_started_at == 0 || estate.last_heartbeat >= guard.fallback_started_at,
        HeirloomError::BadStatus
    );
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
        .checked_add(guard.fallback_wait())
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
}

pub fn execute_fallback_handler(ctx: Context<ExecuteFallback>) -> Result<()> {
    let ts = now()?;
    let wait = ctx.accounts.guard.fallback_wait();
    let obj_info = ctx.accounts.objection.to_account_info();
    let mut lapsed: Option<Objection> = None;
    let objection_open = if account_exists(&obj_info) {
        let mut o: Objection = read_account(&obj_info)?;
        if fallback_objection_lapsed(&o, wait, ts)? {
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
    require!(guard.fallback_started_at != 0, HeirloomError::FallbackNotReady);
    // The owner showed signs of life after the start (heartbeat / veto): the countdown is void.
    require!(
        estate.last_heartbeat < guard.fallback_started_at,
        HeirloomError::FallbackNotReady
    );
    require!(owner_death_established(estate), HeirloomError::FallbackNotReady);
    require!(
        all_vacant([&ctx.accounts.seat0, &ctx.accounts.seat1, &ctx.accounts.seat2]),
        HeirloomError::SeatsNotVacant
    );
    let runs_at = guard
        .fallback_started_at
        .checked_add(guard.fallback_wait())
        .ok_or(HeirloomError::MathOverflow)?;
    require!(ts >= runs_at, HeirloomError::WaitingPeriodNotOver);
    require!(!objection_open, HeirloomError::ObjectionOpen);
    let recipient = guard.next_fallback_recipient();
    require!(is_set(&recipient), HeirloomError::NoFallbackRecipient);

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
    ctx.accounts.estate.status = EstateStatus::Unlocked;

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
        fallback_objection_lapsed(objection, ctx.accounts.guard.fallback_wait(), ts)?
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
