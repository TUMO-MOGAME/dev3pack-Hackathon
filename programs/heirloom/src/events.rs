use anchor_lang::prelude::*;

use crate::state::{AssetKind, TargetKind};

// Field lists are mirrored in docs/program-spec.md ("Events") and the IDL.

#[event]
pub struct EstateCreated {
    pub estate: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub usdt_mint: Pubkey,
    pub ts: i64,
}

#[event]
pub struct WillSet {
    pub estate: Pubkey,
    pub will_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct DeathClaimSubmitted {
    pub estate: Pubkey,
    pub submitted_by: Pubkey,
    pub cert_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct DeathReviewed {
    pub estate: Pubkey,
    pub approved: bool,
    pub report_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct DeathAttested {
    pub estate: Pubkey,
    pub verifier: Pubkey,
    /// Number of attestations so far.
    pub count: u8,
    /// True once the estate is DeathPending (threshold reached).
    pub pending: bool,
    pub ts: i64,
}

#[event]
pub struct DeathVetoed {
    pub estate: Pubkey,
    pub ts: i64,
}

#[event]
pub struct EstateUnlocked {
    pub estate: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ClaimSubmitted {
    pub estate: Pubkey,
    pub rule: Pubkey,
    pub claim: Pubkey,
    pub beneficiary: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct ClaimReviewed {
    pub claim: Pubkey,
    pub approved: bool,
    pub report_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct ClaimApproved {
    pub claim: Pubkey,
    pub verifier: Pubkey,
    pub count: u8,
    pub ts: i64,
}

#[event]
pub struct ClaimOwnerApproved {
    pub claim: Pubkey,
    pub owner: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ScheduledPaid {
    pub estate: Pubkey,
    pub rule: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
    pub next_due: i64,
    pub ts: i64,
}

#[event]
pub struct ClaimPaid {
    pub estate: Pubkey,
    pub rule: Pubkey,
    pub claim: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct AssetRegistered {
    pub estate: Pubkey,
    pub asset: Pubkey,
    pub nft_mint: Pubkey,
    pub floor_price: u64,
    pub hardship_floor: u64,
    pub asking_price: u64,
    pub ts: i64,
}

#[event]
pub struct AssetListed {
    pub asset: Pubkey,
    pub listing_ends: i64,
    pub ts: i64,
}

#[event]
pub struct OfferPlaced {
    pub asset: Pubkey,
    pub offer: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct OfferWithdrawn {
    pub asset: Pubkey,
    pub offer: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct HardshipSubmitted {
    pub asset: Pubkey,
    pub hardship: Pubkey,
    pub beneficiary: Pubkey,
    pub ts: i64,
}

#[event]
pub struct HardshipReviewed {
    pub hardship: Pubkey,
    pub approved: bool,
    pub report_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct HardshipApproved {
    pub asset: Pubkey,
    pub hardship: Pubkey,
    pub verifier: Pubkey,
    pub count: u8,
    /// True once the quorum is reached and the hardship floor applies.
    pub quorum_reached: bool,
    pub ts: i64,
}

#[event]
pub struct AssetSold {
    pub asset: Pubkey,
    pub buyer: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub hardship: bool,
    pub ts: i64,
}

// ---------------------------------------------------------------- guardians (added 2026-11-14)

/// A seat holder approved something (claim, unlock attestation, hardship). Monitors are notified from this.
#[event]
pub struct SeatApproval {
    pub estate: Pubkey,
    pub seat_index: u8,
    pub approver: Pubkey,
    pub kind: TargetKind,
    pub target: Pubkey,
    pub ts: i64,
}

#[event]
pub struct GuardInitialized {
    pub estate: Pubkey,
    pub objection_window_secs: i64,
    pub succession_wait_secs: i64,
    pub fallback_wait_secs: i64,
    pub ts: i64,
}

/// Emitted by init_seat, set_seat_backups, set_seat_monitors and owner_replace_seat.
#[event]
pub struct SeatConfigured {
    pub estate: Pubkey,
    pub seat_index: u8,
    pub holder: Pubkey,
    pub backups: [Pubkey; 2],
    pub monitors: [Pubkey; 2],
    pub generation: u16,
    pub ts: i64,
}

#[event]
pub struct SeatDeathReported {
    pub estate: Pubkey,
    pub seat_index: u8,
    pub holder: Pubkey,
    pub reported_by: Pubkey,
    pub cert_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct SeatDeathReviewed {
    pub estate: Pubkey,
    pub seat_index: u8,
    pub approved: bool,
    pub report_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct SeatDeathConfirmed {
    pub estate: Pubkey,
    pub seat_index: u8,
    pub confirmed_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct SeatDeathVetoed {
    pub estate: Pubkey,
    pub seat_index: u8,
    pub holder: Pubkey,
    pub ts: i64,
}

#[event]
pub struct SuccessionFinalized {
    pub estate: Pubkey,
    pub seat_index: u8,
    pub previous_holder: Pubkey,
    pub new_holder: Pubkey,
    pub generation: u16,
    pub ts: i64,
}

#[event]
pub struct SeatVacated {
    pub estate: Pubkey,
    pub seat_index: u8,
    pub previous_holder: Pubkey,
    pub generation: u16,
    pub ts: i64,
}

#[event]
pub struct ObjectionRaised {
    pub estate: Pubkey,
    pub objection: Pubkey,
    pub target: Pubkey,
    pub kind: TargetKind,
    pub monitor: Pubkey,
    pub seat_index: u8,
    pub reason_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct ObjectionVoted {
    pub objection: Pubkey,
    pub voter: Pubkey,
    pub uphold: bool,
    pub ts: i64,
}

#[event]
pub struct ObjectionResolved {
    pub estate: Pubkey,
    pub objection: Pubkey,
    pub target: Pubkey,
    pub kind: TargetKind,
    pub upheld: bool,
    pub ts: i64,
}

#[event]
pub struct FallbackSet {
    pub estate: Pubkey,
    pub recipients: [Pubkey; 4],
    pub ts: i64,
}

#[event]
pub struct FallbackDeathReported {
    pub estate: Pubkey,
    pub index: u8,
    pub recipient: Pubkey,
    pub reported_by: Pubkey,
    pub cert_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct FallbackDeathReviewed {
    pub estate: Pubkey,
    pub index: u8,
    pub approved: bool,
    pub report_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct FallbackStarted {
    pub estate: Pubkey,
    pub runs_at: i64,
    pub ts: i64,
}

#[event]
pub struct FallbackExecuted {
    pub estate: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct AssetMediaSet {
    pub asset: Pubkey,
    pub kind: AssetKind,
    pub photos_root: [u8; 32],
    pub photo_count: u8,
    pub ts: i64,
}

// ---------------------------------------------------------------- disputes, yearly caps (2026-11-15)

#[event]
pub struct DisputeRaised {
    pub estate: Pubkey,
    pub objection: Pubkey,
    pub target: Pubkey,
    pub kind: TargetKind,
    pub disputer: Pubkey,
    pub reason_hash: [u8; 32],
    pub lapses_at: i64,
    pub ts: i64,
}

#[event]
pub struct DisputeVoted {
    pub objection: Pubkey,
    pub verifier: Pubkey,
    pub uphold: bool,
    pub ts: i64,
}

#[event]
pub struct DisputeResolved {
    pub estate: Pubkey,
    pub objection: Pubkey,
    pub target: Pubkey,
    pub kind: TargetKind,
    pub upheld: bool,
    pub ts: i64,
}

#[event]
pub struct YearlyCapSet {
    pub estate: Pubkey,
    pub rule: Pubkey,
    pub cap: u64,
    pub period_start: i64,
    pub ts: i64,
}
