//! Continuity (added 2026-11-22): end a rule, pay out what no rule needs any more, replace the agent's key.
//! Without these a living plan could not change, a surplus stayed in the vault forever and a lost agent key
//! froze every review.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::{account_exists, now, read_account, record_proof_of_life, transfer_checked_cpi};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

// ====================================================================== end_rule

#[derive(Accounts)]
pub struct EndRule<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(mut, has_one = estate)]
    pub rule: Account<'info, Rule>,
}

/// Owner, estate Active: the rule expires now. Open claims and scheduled payments under it can no longer pay.
pub fn end_rule_handler(ctx: Context<EndRule>) -> Result<()> {
    require!(ctx.accounts.estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    let ts = now()?;
    let rule = &mut ctx.accounts.rule;
    require!(ts <= rule.valid_until, HeirloomError::RuleExpired);
    rule.valid_until = ts.saturating_sub(1);

    emit!(RuleEnded { estate: rule.estate, rule: rule.key(), ts });
    Ok(())
}

// ====================================================================== set_residual

#[derive(Accounts)]
pub struct SetResidual<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Residual::INIT_SPACE,
        seeds = [RESIDUAL_SEED, estate.key().as_ref()],
        bump
    )]
    pub residual: Account<'info, Residual>,

    pub system_program: Program<'info, System>,
}

/// Owner, estate Active: names who receives what is left.
pub fn set_residual_handler(ctx: Context<SetResidual>, recipient: Pubkey) -> Result<()> {
    let estate = &ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    require!(
        recipient != Pubkey::default() && recipient != estate.owner && recipient != estate.key(),
        HeirloomError::NoResidualRecipient
    );

    let estate_key = estate.key();
    let bump = ctx.bumps.residual;
    ctx.accounts.residual.set_inner(Residual { estate: estate_key, recipient, bump });

    emit!(ResidualSet { estate: estate_key, recipient, ts: now()? });
    Ok(())
}

// ====================================================================== sweep_residual

#[derive(Accounts)]
pub struct SweepResidual<'info> {
    /// Anyone; pays the recipient's ATA rent if missing.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    /// CHECK: the ["residual", estate] PDA; may not exist.
    #[account(seeds = [RESIDUAL_SEED, estate.key().as_ref()], bump)]
    pub residual: UncheckedAccount<'info>,

    /// CHECK: the ["guard", estate] PDA; may not exist. Read only when no residual recipient was named.
    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump)]
    pub guard: UncheckedAccount<'info>,

    /// CHECK: the residual recipient, else the first living fallback recipient (checked in the handler).
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
    // remaining_accounts: every Rule of the estate, in id order.
}

/// Anyone, estate Unlocked: pays the vault minus what live rules can still claim. Callable again later
/// (a rule expired, sale proceeds arrived).
pub fn sweep_residual_handler<'info>(ctx: Context<'info, SweepResidual<'info>>) -> Result<()> {
    let estate = &ctx.accounts.estate;
    require!(estate.status == EstateStatus::Unlocked, HeirloomError::BadStatus);

    let residual_info = ctx.accounts.residual.to_account_info();
    let guard_info = ctx.accounts.guard.to_account_info();
    let expected = if account_exists(&residual_info) {
        read_account::<Residual>(&residual_info)?.recipient
    } else if account_exists(&guard_info) {
        read_account::<Guard>(&guard_info)?.next_fallback_recipient()
    } else {
        Pubkey::default()
    };
    require!(
        expected != Pubkey::default() && expected == ctx.accounts.recipient.key(),
        HeirloomError::NoResidualRecipient
    );

    let infos = ctx.remaining_accounts;
    require!(infos.len() == estate.rule_count as usize, HeirloomError::RulesIncomplete);
    let ts = now()?;
    let estate_key = estate.key();
    let mut reserved: u64 = 0;
    for (i, info) in infos.iter().enumerate() {
        let rule: Rule = read_account(info)?;
        // Only this program creates Rules, one per (estate, id), so id == position means none is missing or repeated.
        require!(rule.estate == estate_key && rule.id as usize == i, HeirloomError::RulesIncomplete);
        if ts <= rule.valid_until {
            let left = rule.lifetime_cap.saturating_sub(rule.spent_total);
            reserved = reserved.saturating_add(left);
        }
    }

    let amount = ctx.accounts.vault.amount.saturating_sub(reserved);
    require!(amount > 0, HeirloomError::NothingToSweep);

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

    emit!(ResidualSwept { estate: estate_key, recipient: expected, amount, reserved, ts });
    Ok(())
}

// ====================================================================== set_agent / vote_agent

fn check_candidate(estate: &Estate, candidate: &Pubkey) -> Result<()> {
    require!(
        *candidate != Pubkey::default()
            && *candidate != estate.agent
            && *candidate != estate.owner
            && estate.verifier_index(candidate).is_none(),
        HeirloomError::BadAgent
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,
}

/// Owner, estate Active: replaces the agent. Proof of life, which also voids the old agent's death review.
pub fn set_agent_handler(ctx: Context<SetAgent>, agent: Pubkey) -> Result<()> {
    let estate = &mut ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    check_candidate(estate, &agent)?;
    let previous = estate.agent;
    estate.agent = agent;

    let (key, ts) = (estate.key(), now()?);
    record_proof_of_life(key, estate, ts);
    emit!(AgentChanged { estate: key, previous, agent, ts });
    Ok(())
}

#[derive(Accounts)]
#[instruction(candidate: Pubkey)]
pub struct VoteAgent<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,

    #[account(mut)]
    pub estate: Account<'info, Estate>,

    #[account(
        init_if_needed,
        payer = verifier,
        space = 8 + AgentVote::INIT_SPACE,
        seeds = [AGENT_VOTE_SEED, estate.key().as_ref(), candidate.as_ref()],
        bump
    )]
    pub agent_vote: Account<'info, AgentVote>,

    pub system_program: Program<'info, System>,
}

/// Trusted people replace the agent. While Active it takes every one of them (at least two): the owner may
/// already have died with the agent's key lost. Afterwards it takes two, or the only one left.
pub fn vote_agent_handler(ctx: Context<VoteAgent>, candidate: Pubkey) -> Result<()> {
    let verifier = ctx.accounts.verifier.key();
    let estate = &mut ctx.accounts.estate;
    let idx = estate.verifier_index(&verifier).ok_or(HeirloomError::NotVerifier)?;
    check_candidate(estate, &candidate)?;

    let vote = &mut ctx.accounts.agent_vote;
    if vote.replaces != estate.agent {
        vote.estate = estate.key();
        vote.candidate = candidate;
        vote.replaces = estate.agent;
        vote.voters = [Pubkey::default(); VERIFIER_COUNT];
        vote.bump = ctx.bumps.agent_vote;
    }
    let first_time = vote.voters[idx] != verifier;
    vote.voters[idx] = verifier;

    let (mut seats, mut count) = (0u8, 0u8);
    for (holder, voter) in estate.verifiers.iter().zip(vote.voters.iter()) {
        if *holder == Pubkey::default() {
            continue;
        }
        seats += 1;
        // A vote counts only while the voter still holds that seat.
        if voter == holder {
            count += 1;
        }
    }
    let needed = if estate.status == EstateStatus::Active { seats.max(2) } else { seats.min(2) };

    // Voting again only completes a quorum that has dropped since.
    require!(first_time || count >= needed, HeirloomError::AlreadyApproved);

    let (estate_key, ts) = (estate.key(), now()?);
    emit!(AgentVoted { estate: estate_key, candidate, verifier, count, ts });
    if count >= needed {
        let previous = estate.agent;
        estate.agent = candidate;
        vote.voters = [Pubkey::default(); VERIFIER_COUNT];
        emit!(AgentChanged { estate: estate_key, previous, agent: candidate, ts });
    }
    Ok(())
}
