//! LiteSVM tests for the Heirloom program. Run `anchor build` first (loads target/deploy/heirloom.so),
//! then `cargo test -p heirloom`.
//!
//! SPL mint and token accounts are written straight into the SVM with `set_account` (hand-packed
//! SPL Token layouts), so the tests don't depend on spl-token client crates.

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::instruction::Instruction,
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use heirloom::{
    AssetStatus, ClaimStatus, Estate, EstateStatus, HeirloomError, PayeeKind, Category, Rule, Claim,
    Asset, AssetKind, AssetMedia, ApprovalStamp, Guard, HardshipStatus, Hardship, Objection,
    ObjectionStatus, Seat, TargetKind, Verdict, YearCap,
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const USDT: u64 = 1_000_000; // 6 decimals
const WAITING: i64 = 120; // demo waiting period (2 minutes)
const DAY: i64 = 86_400;

// ---------------------------------------------------------------- program ids

fn token_program() -> Pubkey {
    anchor_spl::token::ID
}
fn ata_program() -> Pubkey {
    anchor_spl::associated_token::ID
}
fn system_program() -> Pubkey {
    anchor_lang::system_program::ID
}

// ---------------------------------------------------------------- PDAs

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &heirloom::id()).0
}
fn estate_pda(owner: &Pubkey) -> Pubkey {
    pda(&[b"estate", owner.as_ref()])
}
fn beneficiary_pda(estate: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"beneficiary", estate.as_ref(), wallet.as_ref()])
}
fn payee_pda(estate: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"payee", estate.as_ref(), wallet.as_ref()])
}
fn rule_pda(estate: &Pubkey, id: u16) -> Pubkey {
    pda(&[b"rule", estate.as_ref(), &id.to_le_bytes()])
}
fn claim_pda(rule: &Pubkey, id: u32) -> Pubkey {
    pda(&[b"claim", rule.as_ref(), &id.to_le_bytes()])
}
fn asset_pda(estate: &Pubkey, nft_mint: &Pubkey) -> Pubkey {
    pda(&[b"asset", estate.as_ref(), nft_mint.as_ref()])
}
fn offer_pda(asset: &Pubkey, buyer: &Pubkey) -> Pubkey {
    pda(&[b"offer", asset.as_ref(), buyer.as_ref()])
}
fn hardship_pda(asset: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"hardship", asset.as_ref(), wallet.as_ref()])
}
fn guard_pda(estate: &Pubkey) -> Pubkey {
    pda(&[b"guard", estate.as_ref()])
}
fn seat_pda(estate: &Pubkey, index: u8) -> Pubkey {
    pda(&[b"seat", estate.as_ref(), &[index]])
}
fn stamp_pda(target: &Pubkey) -> Pubkey {
    pda(&[b"stamp", target.as_ref()])
}
fn objection_pda(target: &Pubkey) -> Pubkey {
    pda(&[b"objection", target.as_ref()])
}
fn media_pda(asset: &Pubkey) -> Pubkey {
    pda(&[b"media", asset.as_ref()])
}
fn year_cap_pda(rule: &Pubkey) -> Pubkey {
    pda(&[b"yearcap", rule.as_ref()])
}
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program().as_ref(), mint.as_ref()],
        &ata_program(),
    )
    .0
}

// ---------------------------------------------------------------- raw SPL Token state

fn pack_mint(authority: &Pubkey, supply: u64, decimals: u8) -> Vec<u8> {
    let mut d = Vec::with_capacity(82);
    d.extend_from_slice(&1u32.to_le_bytes()); // mint_authority: Some
    d.extend_from_slice(authority.as_ref());
    d.extend_from_slice(&supply.to_le_bytes());
    d.push(decimals);
    d.push(1); // is_initialized
    d.extend_from_slice(&0u32.to_le_bytes()); // freeze_authority: None
    d.extend_from_slice(&[0u8; 32]);
    assert_eq!(d.len(), 82);
    d
}

fn pack_token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(165);
    d.extend_from_slice(mint.as_ref());
    d.extend_from_slice(owner.as_ref());
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&0u32.to_le_bytes()); // delegate: None
    d.extend_from_slice(&[0u8; 32]);
    d.push(1); // state: Initialized
    d.extend_from_slice(&0u32.to_le_bytes()); // is_native: None
    d.extend_from_slice(&0u64.to_le_bytes());
    d.extend_from_slice(&0u64.to_le_bytes()); // delegated_amount
    d.extend_from_slice(&0u32.to_le_bytes()); // close_authority: None
    d.extend_from_slice(&[0u8; 32]);
    assert_eq!(d.len(), 165);
    d
}

fn set_token_state(svm: &mut LiteSVM, address: Pubkey, data: Vec<u8>) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner: token_program(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn create_mint(svm: &mut LiteSVM, authority: &Pubkey, supply: u64, decimals: u8) -> Pubkey {
    let mint = Keypair::new().pubkey();
    set_token_state(svm, mint, pack_mint(authority, supply, decimals));
    mint
}

/// Creates (or overwrites) `owner`'s ATA for `mint` holding `amount`.
fn fund_ata(svm: &mut LiteSVM, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Pubkey {
    let address = ata(owner, mint);
    set_token_state(svm, address, pack_token_account(mint, owner, amount));
    address
}

fn balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    match svm.get_account(token_account) {
        Some(acc) if acc.data.len() >= 72 => u64::from_le_bytes(acc.data[64..72].try_into().unwrap()),
        _ => 0,
    }
}

fn is_closed(svm: &LiteSVM, address: &Pubkey) -> bool {
    svm.get_account(address).map_or(true, |a| a.lamports == 0)
}

fn fetch<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let acc = svm.get_account(address).expect("account missing");
    T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
}

// ---------------------------------------------------------------- tx helpers

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(heirloom::id(), &data.data(), accounts.to_account_metas(None))
}

/// Sends one instruction; `signers[0]` pays the fee. Returns the debug form of the error on failure.
fn send(svm: &mut LiteSVM, instruction: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    let payer = signers[0].pubkey();
    let msg = Message::new_with_blockhash(&[instruction], Some(&payer), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let res = svm.send_transaction(tx);
    svm.expire_blockhash();
    res.map(|_| ()).map_err(|e| format!("{:?}", e.err))
}

fn expect_err<T>(res: Result<T, String>, err: HeirloomError) {
    let code = 6000 + err as u32;
    match res {
        Ok(_) => panic!("expected error {code}, but the transaction succeeded"),
        Err(e) => assert!(
            e.contains(&format!("Custom({code})")),
            "expected Custom({code}), got {e}"
        ),
    }
}

fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

fn warp(svm: &mut LiteSVM, secs: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += secs;
    clock.slot += 1;
    svm.set_sysvar::<Clock>(&clock);
}

// ---------------------------------------------------------------- test environment

struct Env {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    verifiers: [Keypair; 3],
    kid1: Keypair,
    kid2: Keypair,
    university: Keypair,
    landlord: Keypair,
    executor: Keypair,
    buyer1: Keypair,
    buyer2: Keypair,
    stranger: Keypair,
    usdt_mint: Pubkey,
    estate: Pubkey,
}

impl Env {
    /// Program loaded, wallets funded with SOL, USD₮ mint created, owner holds 100k USD₮.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/heirloom.so"));
        svm.add_program(heirloom::id(), bytes).unwrap();

        let owner = Keypair::new();
        let env_keys: Vec<Keypair> = (0..11).map(|_| Keypair::new()).collect();
        let mut it = env_keys.into_iter();
        let mut next = || it.next().unwrap();
        let agent = next();
        let verifiers = [next(), next(), next()];
        let kid1 = next();
        let kid2 = next();
        let university = next();
        let landlord = next();
        let executor = next();
        let buyer1 = next();
        let buyer2 = next();
        let stranger = Keypair::new();

        for kp in [&owner, &agent, &verifiers[0], &verifiers[1], &verifiers[2], &kid1, &kid2, &buyer1, &buyer2, &stranger] {
            svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        }

        let usdt_mint = create_mint(&mut svm, &owner.pubkey(), 1_000_000 * USDT, 6);
        fund_ata(&mut svm, &owner.pubkey(), &usdt_mint, 100_000 * USDT);
        let estate = estate_pda(&owner.pubkey());

        Env {
            svm,
            owner,
            agent,
            verifiers,
            kid1,
            kid2,
            university,
            landlord,
            executor,
            buyer1,
            buyer2,
            stranger,
            usdt_mint,
            estate,
        }
    }

    fn vault(&self) -> Pubkey {
        ata(&self.estate, &self.usdt_mint)
    }

    fn verifier_keys(&self) -> [Pubkey; 3] {
        [self.verifiers[0].pubkey(), self.verifiers[1].pubkey(), self.verifiers[2].pubkey()]
    }

    fn create_estate_ix(&self, verifiers: [Pubkey; 3], death: u8, claim: u8, hardship: u8, waiting: i64) -> Instruction {
        ix(
            heirloom::accounts::CreateEstate {
                owner: self.owner.pubkey(),
                estate: self.estate,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
            },
            heirloom::instruction::CreateEstate {
                agent: self.agent.pubkey(),
                verifiers,
                death_threshold: death,
                claim_threshold: claim,
                hardship_threshold: hardship,
                waiting_period_secs: waiting,
            },
        )
    }

    fn create_estate(&mut self) {
        let i = self.create_estate_ix(self.verifier_keys(), 2, 1, 2, WAITING);
        send(&mut self.svm, i, &[&self.owner]).unwrap();
    }

    fn add_beneficiary(&mut self, wallet: Pubkey, label: &str) {
        let i = ix(
            heirloom::accounts::AddBeneficiary {
                owner: self.owner.pubkey(),
                estate: self.estate,
                wallet,
                beneficiary: beneficiary_pda(&self.estate, &wallet),
                system_program: system_program(),
            },
            heirloom::instruction::AddBeneficiary { label: label.to_string() },
        );
        send(&mut self.svm, i, &[&self.owner]).unwrap();
    }

    fn add_payee(&mut self, wallet: Pubkey, kind: PayeeKind, name: &str) {
        let i = ix(
            heirloom::accounts::AddPayee {
                owner: self.owner.pubkey(),
                estate: self.estate,
                wallet,
                payee: payee_pda(&self.estate, &wallet),
                system_program: system_program(),
            },
            heirloom::instruction::AddPayee { kind, name: name.to_string() },
        );
        send(&mut self.svm, i, &[&self.owner]).unwrap();
    }

    fn add_rule(&mut self, id: u16, wallet: Pubkey, kind: PayeeKind, max_per_claim: u64, lifetime_cap: u64, valid_until: i64) -> Pubkey {
        let i = self.add_rule_ix(id, wallet, kind, max_per_claim, lifetime_cap, valid_until, false, 0, 0, 0, None);
        send(&mut self.svm, i, &[&self.owner]).unwrap();
        rule_pda(&self.estate, id)
    }

    /// Full add_rule: living plan (`starts_now`) and/or a scheduled payment to `payee_wallet`.
    fn add_rule_ix(
        &self,
        id: u16,
        wallet: Pubkey,
        kind: PayeeKind,
        max_per_claim: u64,
        lifetime_cap: u64,
        valid_until: i64,
        starts_now: bool,
        recurring_amount: u64,
        interval_secs: i64,
        first_due: i64,
        payee_wallet: Option<Pubkey>,
    ) -> Instruction {
        ix(
            heirloom::accounts::AddRule {
                owner: self.owner.pubkey(),
                estate: self.estate,
                beneficiary: beneficiary_pda(&self.estate, &wallet),
                rule: rule_pda(&self.estate, id),
                payee: payee_wallet.map(|w| payee_pda(&self.estate, &w)),
                system_program: system_program(),
            },
            heirloom::instruction::AddRule {
                category: Category::Tuition,
                allowed_payee_kind: kind,
                max_per_claim,
                lifetime_cap,
                valid_until,
                starts_now,
                recurring_amount,
                interval_secs,
                first_due,
            },
        )
    }

    fn owner_approve_claim(&mut self, rule: Pubkey, claim: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::OwnerApproveClaim { owner: self.owner.pubkey(), estate: self.estate, rule, claim },
            heirloom::instruction::OwnerApproveClaim {},
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn execute_scheduled(&mut self, rule: Pubkey) -> Result<(), String> {
        let r: Rule = fetch(&self.svm, &rule);
        let i = ix(
            heirloom::accounts::ExecuteScheduled {
                payer: self.stranger.pubkey(),
                estate: self.estate,
                rule,
                payee_wallet: r.fixed_payee,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                payee_usdt: ata(&r.fixed_payee, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                year_cap: year_cap_pda(&rule),
            },
            heirloom::instruction::ExecuteScheduled {},
        );
        send(&mut self.svm, i, &[&self.stranger])
    }

    fn deposit_ix(&self, owner_usdt: Pubkey, amount: u64) -> Instruction {
        ix(
            heirloom::accounts::Deposit {
                owner: self.owner.pubkey(),
                estate: self.estate,
                usdt_mint: self.usdt_mint,
                owner_usdt,
                vault: self.vault(),
                token_program: token_program(),
            },
            heirloom::instruction::Deposit { amount },
        )
    }

    fn submit_death_claim(&mut self, who: usize) -> Result<(), String> {
        let kid = if who == 1 { &self.kid1 } else { &self.kid2 };
        let i = ix(
            heirloom::accounts::SubmitDeathClaim {
                beneficiary: kid.pubkey(),
                estate: self.estate,
                beneficiary_account: beneficiary_pda(&self.estate, &kid.pubkey()),
            },
            heirloom::instruction::SubmitDeathClaim { cert_hash: [7u8; 32] },
        );
        send(&mut self.svm, i, &[kid])
    }

    fn review_death(&mut self, approve: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReviewDeath { agent: self.agent.pubkey(), estate: self.estate },
            heirloom::instruction::ReviewDeath { approve, report_hash: [9u8; 32] },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn attest_death_by(&mut self, signer: &Keypair) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::AttestDeath { verifier: signer.pubkey(), estate: self.estate },
            heirloom::instruction::AttestDeath {},
        );
        send(&mut self.svm, i, &[signer])
    }

    fn attest_death(&mut self, v: usize) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::AttestDeath { verifier: self.verifiers[v].pubkey(), estate: self.estate },
            heirloom::instruction::AttestDeath {},
        );
        send(&mut self.svm, i, &[&self.verifiers[v]])
    }

    fn veto_death(&mut self) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::VetoDeath { owner: self.owner.pubkey(), estate: self.estate },
            heirloom::instruction::VetoDeath {},
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn finalize_unlock(&mut self) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::FinalizeUnlock { estate: self.estate, objection: objection_pda(&self.estate), caller: self.stranger.pubkey() },
            heirloom::instruction::FinalizeUnlock {},
        );
        send(&mut self.svm, i, &[&self.stranger])
    }

    fn estate_state(&self) -> Estate {
        fetch(&self.svm, &self.estate)
    }

    /// Runs the full death flow through to Unlocked.
    fn unlock(&mut self) {
        self.submit_death_claim(1).unwrap();
        self.review_death(true).unwrap();
        self.attest_death(0).unwrap();
        self.attest_death(1).unwrap();
        warp(&mut self.svm, WAITING);
        self.finalize_unlock().unwrap();
        assert_eq!(self.estate_state().status, EstateStatus::Unlocked);
    }

    /// Estate with kid1 + kid2, a university and a landlord payee, and 5,000 USD₮ in the vault.
    fn configured() -> Self {
        let mut env = Env::new();
        env.create_estate();
        let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
        env.add_beneficiary(k1, "Child 1");
        env.add_beneficiary(k2, "Child 2");
        let (uni, ll) = (env.university.pubkey(), env.landlord.pubkey());
        env.add_payee(uni, PayeeKind::University, "University of Cape Town");
        env.add_payee(ll, PayeeKind::Landlord, "Res Landlord");
        let owner_usdt = ata(&env.owner.pubkey(), &env.usdt_mint);
        let i = env.deposit_ix(owner_usdt, 5_000 * USDT);
        send(&mut env.svm, i, &[&env.owner]).unwrap();
        env
    }

    // ---------------- claims

    fn submit_claim(&mut self, signer_is_kid1: bool, rule: Pubkey, payee_wallet: Pubkey, amount: u64) -> Result<Pubkey, String> {
        let kid = if signer_is_kid1 { &self.kid1 } else { &self.kid2 };
        let r: Rule = fetch(&self.svm, &rule);
        let claim = claim_pda(&rule, r.claim_count);
        let i = ix(
            heirloom::accounts::SubmitClaim {
                beneficiary: kid.pubkey(),
                estate: self.estate,
                beneficiary_account: beneficiary_pda(&self.estate, &kid.pubkey()),
                rule,
                payee: payee_pda(&self.estate, &payee_wallet),
                claim,
                system_program: system_program(),
                year_cap: year_cap_pda(&rule),
            },
            heirloom::instruction::SubmitClaim { amount, evidence_hash: [1u8; 32] },
        );
        send(&mut self.svm, i, &[kid]).map(|_| claim)
    }

    fn review_claim(&mut self, claim: Pubkey, approve: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReviewClaim { agent: self.agent.pubkey(), estate: self.estate, claim },
            heirloom::instruction::ReviewClaim { approve, report_hash: [2u8; 32] },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn approve_claim(&mut self, claim: Pubkey, v: usize) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ApproveClaim {
                verifier: self.verifiers[v].pubkey(),
                estate: self.estate,
                claim,
                payer: self.verifiers[v].pubkey(),
                approval_stamp: stamp_pda(&claim),
                system_program: system_program(),
            },
            heirloom::instruction::ApproveClaim {},
        );
        send(&mut self.svm, i, &[&self.verifiers[v]])
    }

    fn execute_claim(&mut self, rule: Pubkey, claim: Pubkey) -> Result<(), String> {
        let c: Claim = fetch(&self.svm, &claim);
        let i = ix(
            heirloom::accounts::ExecuteClaim {
                payer: self.stranger.pubkey(),
                estate: self.estate,
                rule,
                claim,
                payee_wallet: c.payee,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                payee_usdt: ata(&c.payee, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                guard: guard_pda(&self.estate),
                approval_stamp: stamp_pda(&claim),
                objection: objection_pda(&claim),
                year_cap: year_cap_pda(&rule),
            },
            heirloom::instruction::ExecuteClaim {},
        );
        send(&mut self.svm, i, &[&self.stranger])
    }

    /// Submit -> agent approves -> verifier 0 approves -> execute.
    fn pay_claim(&mut self, rule: Pubkey, payee_wallet: Pubkey, amount: u64) {
        let claim = self.submit_claim(true, rule, payee_wallet, amount).unwrap();
        self.review_claim(claim, true).unwrap();
        self.approve_claim(claim, 0).unwrap();
        self.execute_claim(rule, claim).unwrap();
    }
}

// ---------------------------------------------------------------- sale environment

struct Sale {
    env: Env,
    nft_mint: Pubkey,
    asset: Pubkey,
    /// Backups and monitors when built with a Guard (`Sale::build(true)`).
    people: Option<People>,
}

const FLOOR: u64 = 9_000 * USDT;
const HARDSHIP_FLOOR: u64 = 7_000 * USDT;
const ASKING: u64 = 10_000 * USDT;

impl Sale {
    /// Configured estate + registered car NFT, unlocked, listed for 3 days; buyers hold 20k USD₮.
    fn new() -> Self {
        Sale::build(false)
    }

    /// As `new`; with `guarded`, a Guard and 3 Seats are set up before the unlock.
    fn build(guarded_estate: bool) -> Self {
        let mut env = Env::configured();
        let people = if guarded_estate { Some(guarded(&mut env)) } else { None };
        let owner = env.owner.pubkey();
        let nft_mint = create_mint(&mut env.svm, &owner, 1, 0);
        let owner_nft = fund_ata(&mut env.svm, &owner, &nft_mint, 1);
        let asset = asset_pda(&env.estate, &nft_mint);

        let i = ix(
            heirloom::accounts::RegisterAsset {
                owner,
                estate: env.estate,
                nft_mint,
                owner_nft,
                nft_escrow: ata(&env.estate, &nft_mint),
                asset,
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
            },
            heirloom::instruction::RegisterAsset {
                floor_price: FLOOR,
                hardship_floor: HARDSHIP_FLOOR,
                asking_price: ASKING,
                proceeds_to: env.executor.pubkey(),
                doc_hash: [3u8; 32],
            },
        );
        send(&mut env.svm, i, &[&env.owner]).unwrap();
        assert_eq!(balance(&env.svm, &ata(&env.estate, &nft_mint)), 1);
        assert_eq!(balance(&env.svm, &owner_nft), 0);

        env.unlock();

        let i = ix(
            heirloom::accounts::ListAsset { authority: env.agent.pubkey(), estate: env.estate, asset },
            heirloom::instruction::ListAsset { duration_secs: 3 * DAY },
        );
        send(&mut env.svm, i, &[&env.agent]).unwrap();

        let mint = env.usdt_mint;
        let (b1, b2) = (env.buyer1.pubkey(), env.buyer2.pubkey());
        fund_ata(&mut env.svm, &b1, &mint, 20_000 * USDT);
        fund_ata(&mut env.svm, &b2, &mint, 20_000 * USDT);

        Sale { env, nft_mint, asset, people }
    }

    fn buyer(&self, n: usize) -> &Keypair {
        if n == 1 { &self.env.buyer1 } else { &self.env.buyer2 }
    }

    fn place_offer(&mut self, n: usize, amount: u64) -> Result<(), String> {
        let buyer = self.buyer(n).pubkey();
        let offer = offer_pda(&self.asset, &buyer);
        let i = ix(
            heirloom::accounts::PlaceOffer {
                buyer,
                estate: self.env.estate,
                asset: self.asset,
                usdt_mint: self.env.usdt_mint,
                buyer_usdt: ata(&buyer, &self.env.usdt_mint),
                offer,
                offer_escrow: ata(&offer, &self.env.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
            },
            heirloom::instruction::PlaceOffer { amount },
        );
        let kp = if n == 1 { &self.env.buyer1 } else { &self.env.buyer2 };
        send(&mut self.env.svm, i, &[kp])
    }

    fn withdraw_offer(&mut self, n: usize) -> Result<(), String> {
        let buyer = self.buyer(n).pubkey();
        let offer = offer_pda(&self.asset, &buyer);
        let i = ix(
            heirloom::accounts::WithdrawOffer {
                buyer,
                estate: self.env.estate,
                asset: self.asset,
                usdt_mint: self.env.usdt_mint,
                buyer_usdt: ata(&buyer, &self.env.usdt_mint),
                offer,
                offer_escrow: ata(&offer, &self.env.usdt_mint),
                token_program: token_program(),
            },
            heirloom::instruction::WithdrawOffer {},
        );
        let kp = if n == 1 { &self.env.buyer1 } else { &self.env.buyer2 };
        send(&mut self.env.svm, i, &[kp])
    }

    fn accept_offer(&mut self, n: usize) -> Result<(), String> {
        let buyer = self.buyer(n).pubkey();
        let offer = offer_pda(&self.asset, &buyer);
        let a: Asset = fetch(&self.env.svm, &self.asset);
        let recipient = a.hardship_beneficiary.unwrap_or(a.proceeds_to);
        let i = ix(
            heirloom::accounts::AcceptOffer {
                agent: self.env.agent.pubkey(),
                estate: self.env.estate,
                asset: self.asset,
                offer,
                buyer,
                recipient,
                usdt_mint: self.env.usdt_mint,
                offer_escrow: ata(&offer, &self.env.usdt_mint),
                recipient_usdt: ata(&recipient, &self.env.usdt_mint),
                nft_mint: self.nft_mint,
                nft_escrow: ata(&self.env.estate, &self.nft_mint),
                buyer_nft: ata(&buyer, &self.nft_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                objection: objection_pda(&self.asset),
                hardship_objection: a
                    .hardship_beneficiary
                    .map(|b| objection_pda(&hardship_pda(&self.asset, &b)))
                    .unwrap_or_else(system_program),
            },
            heirloom::instruction::AcceptOffer {},
        );
        send(&mut self.env.svm, i, &[&self.env.agent])
    }

    fn submit_hardship(&mut self) -> Result<Pubkey, String> {
        let kid = self.env.kid2.pubkey();
        let hardship = hardship_pda(&self.asset, &kid);
        let i = ix(
            heirloom::accounts::SubmitHardship {
                beneficiary: kid,
                estate: self.env.estate,
                beneficiary_account: beneficiary_pda(&self.env.estate, &kid),
                asset: self.asset,
                hardship,
                system_program: system_program(),
            },
            heirloom::instruction::SubmitHardship { evidence_hash: [4u8; 32] },
        );
        send(&mut self.env.svm, i, &[&self.env.kid2]).map(|_| hardship)
    }

    fn review_hardship(&mut self, hardship: Pubkey, approve: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReviewHardship {
                agent: self.env.agent.pubkey(),
                estate: self.env.estate,
                asset: self.asset,
                hardship,
            },
            heirloom::instruction::ReviewHardship { approve, report_hash: [5u8; 32] },
        );
        send(&mut self.env.svm, i, &[&self.env.agent])
    }

    fn approve_hardship(&mut self, hardship: Pubkey, v: usize) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ApproveHardship {
                verifier: self.env.verifiers[v].pubkey(),
                estate: self.env.estate,
                asset: self.asset,
                hardship,
            },
            heirloom::instruction::ApproveHardship {},
        );
        send(&mut self.env.svm, i, &[&self.env.verifiers[v]])
    }

    /// kid2's hardship: submitted, agent-approved, and approved by 2 of 3 verifiers.
    fn approved_hardship(&mut self) {
        let h = self.submit_hardship().unwrap();
        self.review_hardship(h, true).unwrap();
        self.approve_hardship(h, 0).unwrap();
        self.approve_hardship(h, 2).unwrap();
        let a: Asset = fetch(&self.env.svm, &self.asset);
        assert_eq!(a.hardship_beneficiary, Some(self.env.kid2.pubkey()));
    }
}

// =================================================================== tests: setup

#[test]
fn create_estate_validation() {
    let mut env = Env::new();
    let v = env.verifier_keys();
    let owner = env.owner.pubkey();

    let i = env.create_estate_ix(v, 0, 1, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidThreshold);

    let i = env.create_estate_ix(v, 2, 4, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidThreshold);

    let i = env.create_estate_ix(v, 2, 1, 2, -1);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidThreshold);

    let i = env.create_estate_ix([v[0], v[0], v[2]], 2, 1, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::DuplicateVerifier);

    let i = env.create_estate_ix([v[0], owner, v[2]], 2, 1, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::DuplicateVerifier);

    env.create_estate();
    let e = env.estate_state();
    assert_eq!(e.owner, owner);
    assert_eq!(e.agent, env.agent.pubkey());
    assert_eq!(e.usdt_mint, env.usdt_mint);
    assert_eq!(e.verifiers, v);
    assert_eq!((e.death_threshold, e.claim_threshold, e.hardship_threshold), (2, 1, 2));
    assert_eq!(e.status, EstateStatus::Active);
    assert_eq!(e.last_heartbeat, now(&env.svm));
    assert!(env.svm.get_account(&env.vault()).is_some(), "vault ATA created");
}

#[test]
fn deposit_and_withdraw_respect_mint_and_status() {
    let mut env = Env::configured();
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);

    // A token account of another mint is rejected.
    let fake_mint = create_mint(&mut env.svm, &env.owner.pubkey(), 1_000 * USDT, 6);
    let owner = env.owner.pubkey();
    let fake_ata = fund_ata(&mut env.svm, &owner, &fake_mint, 1_000 * USDT);
    let i = env.deposit_ix(fake_ata, 10 * USDT);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::WrongMint);

    // Owner can withdraw while Active.
    let owner_usdt = ata(&owner, &env.usdt_mint);
    let withdraw = |env: &Env, amount: u64| {
        ix(
            heirloom::accounts::Withdraw {
                owner: env.owner.pubkey(),
                estate: env.estate,
                usdt_mint: env.usdt_mint,
                owner_usdt,
                vault: env.vault(),
                token_program: token_program(),
            },
            heirloom::instruction::Withdraw { amount },
        )
    };
    let i = withdraw(&env, 1_000 * USDT);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 4_000 * USDT);

    // ...but not after unlock.
    env.unlock();
    let i = withdraw(&env, 1 * USDT);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadStatus);
}

// =================================================================== tests: death flow

#[test]
fn death_flow_unlocks_after_quorum_and_waiting_period() {
    let mut env = Env::configured();

    env.submit_death_claim(1).unwrap();
    // A second claim can't reset the open one.
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
    // Verifiers can't attest before the agent approves.
    expect_err(env.attest_death(0), HeirloomError::AgentNotApproved);

    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    expect_err(env.attest_death(0), HeirloomError::AlreadyApproved);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    expect_err(env.attest_death_by(&stranger), HeirloomError::NotVerifier);
    assert_eq!(env.estate_state().status, EstateStatus::Active);

    env.attest_death(1).unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::DeathPending);
    assert_eq!(e.death_attestations, 0b011);
    let since = e.death_pending_since;

    // Unlock before the waiting period fails.
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, WAITING - 10);
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);

    // A third attestation doesn't restart the timer.
    env.attest_death(2).unwrap();
    assert_eq!(env.estate_state().death_pending_since, since);

    warp(&mut env.svm, 10);
    env.finalize_unlock().unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);

    // Owner can't veto after unlock.
    expect_err(env.veto_death(), HeirloomError::BadStatus);
}

#[test]
fn veto_resets_death_claim() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);

    warp(&mut env.svm, 30);
    env.veto_death().unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::Active);
    assert_eq!(e.death_cert_hash, [0u8; 32]);
    assert_eq!(e.death_attestations, 0);
    assert_eq!(e.last_heartbeat, now(&env.svm));

    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);

    // A fresh claim starts again from zero.
    env.submit_death_claim(2).unwrap();
    expect_err(env.attest_death(0), HeirloomError::AgentNotApproved);
}

#[test]
fn agent_rejection_clears_death_claim() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(false).unwrap();
    let e = env.estate_state();
    assert_eq!(e.death_cert_hash, [0u8; 32]);
    expect_err(env.attest_death(0), HeirloomError::NoDeathClaim);
}

// =================================================================== tests: claims

fn claims_env() -> (Env, Pubkey) {
    let mut env = Env::configured();
    let valid_until = now(&env.svm) + 365 * DAY;
    let kid1 = env.kid1.pubkey();
    // Tuition for kid1, paid to a University: 600 per claim, 1,000 lifetime.
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until);
    (env, rule)
}

#[test]
fn claim_before_unlock_fails() {
    let (mut env, rule) = claims_env();
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(true, rule, uni, 100 * USDT), HeirloomError::BadStatus);
}

#[test]
fn claim_within_caps_pays_the_payee() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();

    let claim = env.submit_claim(true, rule, uni, 500 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    expect_err(env.approve_claim(claim, 0), HeirloomError::AlreadyApproved);
    env.execute_claim(rule, claim).unwrap();

    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 500 * USDT);
    assert_eq!(balance(&env.svm, &env.vault()), 4_500 * USDT);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.spent_total, 500 * USDT);
    assert_eq!(r.claim_count, 1);
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Paid);

    // Can't be paid twice.
    expect_err(env.execute_claim(rule, claim), HeirloomError::BadStatus);
}

#[test]
fn claim_over_per_claim_cap_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(true, rule, uni, 601 * USDT), HeirloomError::ExceedsPerClaimCap);
}

#[test]
fn claim_over_lifetime_cap_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    env.pay_claim(rule, uni, 600 * USDT);
    expect_err(env.submit_claim(true, rule, uni, 500 * USDT), HeirloomError::ExceedsLifetimeCap);
    // Exactly up to the cap is fine.
    env.pay_claim(rule, uni, 400 * USDT);
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 1_000 * USDT);
}

#[test]
fn lifetime_cap_rechecked_at_execution() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    // Two open claims that together exceed the lifetime cap.
    let c1 = env.submit_claim(true, rule, uni, 600 * USDT).unwrap();
    let c2 = env.submit_claim(true, rule, uni, 600 * USDT).unwrap();
    for c in [c1, c2] {
        env.review_claim(c, true).unwrap();
        env.approve_claim(c, 1).unwrap();
    }
    env.execute_claim(rule, c1).unwrap();
    expect_err(env.execute_claim(rule, c2), HeirloomError::ExceedsLifetimeCap);
}

#[test]
fn claim_to_wrong_payee_kind_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let landlord = env.landlord.pubkey();
    expect_err(env.submit_claim(true, rule, landlord, 100 * USDT), HeirloomError::WrongPayeeKind);
}

#[test]
fn claim_by_other_beneficiary_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(false, rule, uni, 100 * USDT), HeirloomError::NotBeneficiary);
}

#[test]
fn claim_after_rule_expiry_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    warp(&mut env.svm, 366 * DAY);
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(true, rule, uni, 100 * USDT), HeirloomError::RuleExpired);
}

#[test]
fn claim_with_insufficient_approvals_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();

    // Verifiers can't approve before the agent.
    expect_err(env.approve_claim(claim, 0), HeirloomError::AgentNotApproved);
    expect_err(env.execute_claim(rule, claim), HeirloomError::AgentNotApproved);

    env.review_claim(claim, true).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn agent_rejected_claim_cannot_be_paid() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, false).unwrap();
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Rejected);
    expect_err(env.approve_claim(claim, 0), HeirloomError::BadStatus);
    expect_err(env.execute_claim(rule, claim), HeirloomError::BadStatus);
}

// =================================================================== tests: asset sale

#[test]
fn offer_below_floor_rejected_and_best_offer_settles_atomically() {
    let mut s = Sale::new();
    let usdt = s.env.usdt_mint;
    let (b1, b2) = (s.env.buyer1.pubkey(), s.env.buyer2.pubkey());
    let executor = s.env.executor.pubkey();

    s.place_offer(1, 8_000 * USDT).unwrap();
    s.place_offer(2, 9_500 * USDT).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&b1, &usdt)), 12_000 * USDT);

    expect_err(s.accept_offer(1), HeirloomError::BelowFloor);

    s.accept_offer(2).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&executor, &usdt)), 9_500 * USDT);
    assert_eq!(balance(&s.env.svm, &ata(&b2, &s.nft_mint)), 1);
    assert_eq!(balance(&s.env.svm, &ata(&s.env.estate, &s.nft_mint)), 0);
    let a: Asset = fetch(&s.env.svm, &s.asset);
    assert_eq!(a.status, AssetStatus::Sold);
    let offer2 = offer_pda(&s.asset, &b2);
    assert!(is_closed(&s.env.svm, &offer2));
    assert!(is_closed(&s.env.svm, &ata(&offer2, &usdt)));

    // The losing buyer gets the full refund after the sale.
    s.withdraw_offer(1).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&b1, &usdt)), 20_000 * USDT);

    // Nothing more can be sold or offered.
    expect_err(s.place_offer(1, 9_999 * USDT), HeirloomError::BadStatus);
}

#[test]
fn hardship_approved_allows_hardship_floor_and_pays_hardship_beneficiary() {
    let mut s = Sale::new();
    let usdt = s.env.usdt_mint;
    let kid2 = s.env.kid2.pubkey();
    let b1 = s.env.buyer1.pubkey();

    s.place_offer(1, 7_500 * USDT).unwrap();
    expect_err(s.accept_offer(1), HeirloomError::BelowFloor);

    let h = s.submit_hardship().unwrap();
    expect_err(s.approve_hardship(h, 0), HeirloomError::AgentNotApproved);
    s.review_hardship(h, true).unwrap();
    s.approve_hardship(h, 0).unwrap();
    expect_err(s.approve_hardship(h, 0), HeirloomError::AlreadyApproved);
    // One approval is below the hardship quorum (2): still bound by the normal floor.
    expect_err(s.accept_offer(1), HeirloomError::BelowFloor);
    s.approve_hardship(h, 1).unwrap();

    s.accept_offer(1).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&kid2, &usdt)), 7_500 * USDT);
    assert_eq!(balance(&s.env.svm, &ata(&s.env.executor.pubkey(), &usdt)), 0);
    assert_eq!(balance(&s.env.svm, &ata(&b1, &s.nft_mint)), 1);
}

#[test]
fn offer_below_hardship_floor_rejected() {
    let mut s = Sale::new();
    s.approved_hardship();
    s.place_offer(1, 6_999 * USDT).unwrap();
    expect_err(s.accept_offer(1), HeirloomError::BelowHardshipFloor);
    let a: Asset = fetch(&s.env.svm, &s.asset);
    assert_eq!(a.status, AssetStatus::Listed);
}

#[test]
fn withdraw_offer_refunds_buyer() {
    let mut s = Sale::new();
    let usdt = s.env.usdt_mint;
    let b1 = s.env.buyer1.pubkey();
    let offer = offer_pda(&s.asset, &b1);

    s.place_offer(1, 9_000 * USDT).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&b1, &usdt)), 11_000 * USDT);
    assert_eq!(balance(&s.env.svm, &ata(&offer, &usdt)), 9_000 * USDT);

    s.withdraw_offer(1).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&b1, &usdt)), 20_000 * USDT);
    assert!(is_closed(&s.env.svm, &offer));
    assert!(is_closed(&s.env.svm, &ata(&offer, &usdt)));

    // The offer is gone, so it can't be accepted.
    assert!(s.accept_offer(1).is_err());
}

#[test]
fn offers_after_listing_end_rejected() {
    let mut s = Sale::new();
    warp(&mut s.env.svm, 3 * DAY);
    expect_err(s.place_offer(1, 9_500 * USDT), HeirloomError::ListingClosed);
}

// =================================================================== tests: living plans + scheduled payments

const MINUTE: i64 = 60;

#[test]
fn scheduled_payment_pays_when_due_and_stops_at_lifetime_cap() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let first_due = now(&env.svm) + MINUTE;
    // Living plan: 400 every minute to the university, 1,000 lifetime.
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 400 * USDT, MINUTE, first_due, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!((r.fixed_payee, r.next_due, r.interval_secs), (uni, first_due, MINUTE));

    // Estate is Active (owner alive) and the rule starts now.
    expect_err(env.execute_scheduled(rule), HeirloomError::NotDue);
    warp(&mut env.svm, MINUTE);
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 400 * USDT);
    expect_err(env.execute_scheduled(rule), HeirloomError::NotDue);

    warp(&mut env.svm, MINUTE);
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 800 * USDT);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.spent_total, 800 * USDT);
    assert_eq!(r.next_due, first_due + 2 * MINUTE);

    warp(&mut env.svm, MINUTE);
    expect_err(env.execute_scheduled(rule), HeirloomError::ExceedsLifetimeCap);
    assert_eq!(balance(&env.svm, &env.vault()), 4_200 * USDT);
}

#[test]
fn scheduled_payment_waits_for_unlock_unless_starts_now() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let first_due = now(&env.svm);
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, false, 100 * USDT, MINUTE, first_due, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);

    expect_err(env.execute_scheduled(rule), HeirloomError::BadStatus);
    env.unlock();
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 100 * USDT);
}

#[test]
fn recurring_rule_needs_a_payee_of_the_allowed_kind() {
    let mut env = Env::configured();
    let (kid1, ll) = (env.kid1.pubkey(), env.landlord.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let t = now(&env.svm);

    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 100 * USDT, MINUTE, t, None);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::PayeeRequired);

    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 100 * USDT, MINUTE, t, Some(ll));
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::WrongPayeeKind);

    let i = env.add_rule_ix(0, kid1, PayeeKind::Landlord, 600 * USDT, 1_000 * USDT, valid_until, true, 100 * USDT, 0, t, Some(ll));
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidAmount);

    let i = env.add_rule_ix(0, kid1, PayeeKind::Landlord, 600 * USDT, 1_000 * USDT, valid_until, true, 700 * USDT, MINUTE, t, Some(ll));
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::ExceedsPerClaimCap);

    let i = env.add_rule_ix(0, kid1, PayeeKind::Landlord, 600 * USDT, 1_000 * USDT, valid_until, true, 100 * USDT, MINUTE, t, Some(ll));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
}

#[test]
fn living_plan_claim_needs_owner_approval_while_active() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);

    // Estate Active: a starts_now rule accepts claims.
    let claim = env.submit_claim(true, rule, uni, 300 * USDT).unwrap();
    expect_err(env.owner_approve_claim(rule, claim), HeirloomError::AgentNotApproved);
    env.review_claim(claim, true).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    // Verifier approvals alone don't release money while the owner is alive.
    env.approve_claim(claim, 0).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);

    env.owner_approve_claim(rule, claim).unwrap();
    expect_err(env.owner_approve_claim(rule, claim), HeirloomError::AlreadyApproved);
    env.execute_claim(rule, claim).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 300 * USDT);
    let c: Claim = fetch(&env.svm, &claim);
    assert!(c.owner_approved);
    assert_eq!(c.status, ClaimStatus::Paid);
}

#[test]
fn owner_cannot_approve_after_unlock() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    env.unlock();
    let claim = env.submit_claim(true, rule, uni, 300 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    expect_err(env.owner_approve_claim(rule, claim), HeirloomError::BadStatus);
    env.approve_claim(claim, 0).unwrap();
    env.execute_claim(rule, claim).unwrap();
}

// =================================================================== guardians (2026-11-14)
// Seats with backups and monitors, objections, succession, the fallback plan and asset photos.
// Spec: docs/guardians-spec.md §2.

const WINDOW: i64 = 60; // objection window for claims
const SUCCESSION_WAIT: i64 = 60;
const FALLBACK_WAIT: i64 = 120;

fn d() -> Pubkey {
    Pubkey::default()
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

/// Backups (2 per seat) and one monitor per seat.
struct People {
    backups: [[Keypair; 2]; 3],
    monitors: [Keypair; 3],
}

impl People {
    fn new(svm: &mut LiteSVM) -> Self {
        let mut b = || [funded(svm), funded(svm)];
        let backups = [b(), b(), b()];
        let monitors = [funded(svm), funded(svm), funded(svm)];
        People { backups, monitors }
    }
}

impl Env {
    fn kp(&self, k: &Keypair) -> Keypair {
        k.insecure_clone()
    }

    fn v(&self, i: usize) -> Keypair {
        self.verifiers[i].insecure_clone()
    }

    fn seat(&self, index: u8) -> Seat {
        fetch(&self.svm, &seat_pda(&self.estate, index))
    }

    fn guard(&self) -> Guard {
        fetch(&self.svm, &guard_pda(&self.estate))
    }

    fn init_guard(&mut self) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::InitGuard {
                authority: self.owner.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                system_program: system_program(),
            },
            heirloom::instruction::InitGuard {
                objection_window_secs: WINDOW,
                succession_wait_secs: SUCCESSION_WAIT,
                fallback_wait_secs: FALLBACK_WAIT,
            },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn init_seat(&mut self, index: u8, backups: [Pubkey; 2], monitors: [Pubkey; 2]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::InitSeat {
                owner: self.owner.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
                system_program: system_program(),
            },
            heirloom::instruction::InitSeat { index, backups, monitors },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn set_seat_backups(&mut self, signer: &Keypair, index: u8, backups: [Pubkey; 2]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetSeatBackups {
                authority: signer.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::SetSeatBackups { index, backups },
        );
        send(&mut self.svm, i, &[signer])
    }

    fn set_seat_monitors(&mut self, index: u8, monitors: [Pubkey; 2]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetSeatMonitors {
                owner: self.owner.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::SetSeatMonitors { index, monitors },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn report_seat_death(&mut self, reporter: &Keypair, index: u8) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReportSeatDeath {
                reporter: reporter.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::ReportSeatDeath { index, cert_hash: [8u8; 32] },
        );
        send(&mut self.svm, i, &[reporter])
    }

    fn review_seat_death(&mut self, index: u8, approve: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReviewSeatDeath {
                agent: self.agent.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::ReviewSeatDeath { index, approve, report_hash: [9u8; 32] },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn confirm_seat_death(&mut self, confirmer: &Keypair, index: u8) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ConfirmSeatDeath {
                confirmer: confirmer.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::ConfirmSeatDeath { index },
        );
        send(&mut self.svm, i, &[confirmer])
    }

    fn veto_seat_death(&mut self, holder: &Keypair, index: u8) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::VetoSeatDeath {
                holder: holder.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::VetoSeatDeath { index },
        );
        send(&mut self.svm, i, &[holder])
    }

    fn finalize_succession(&mut self, index: u8) -> Result<(), String> {
        let seat = seat_pda(&self.estate, index);
        let i = ix(
            heirloom::accounts::FinalizeSuccession {
                estate: self.estate,
                guard: guard_pda(&self.estate),
                seat,
                objection: objection_pda(&seat),
                caller: self.stranger.pubkey(),
            },
            heirloom::instruction::FinalizeSuccession { index },
        );
        let payer = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&payer])
    }

    /// Report (by kid1) -> agent approves -> `confirmer` confirms -> wait -> finalize.
    fn succeed(&mut self, index: u8, confirmer: &Keypair) {
        let kid1 = self.kid1.insecure_clone();
        self.report_seat_death(&kid1, index).unwrap();
        self.review_seat_death(index, true).unwrap();
        self.confirm_seat_death(confirmer, index).unwrap();
        warp(&mut self.svm, SUCCESSION_WAIT);
        self.finalize_succession(index).unwrap();
    }

    fn raise_objection(
        &mut self,
        objector: &Keypair,
        kind: TargetKind,
        target: Pubkey,
        seat_index: u8,
        seat: Option<Pubkey>,
        as_beneficiary: bool,
        target_account: Option<Pubkey>,
        asset: Option<Pubkey>,
    ) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::RaiseObjection {
                objector: objector.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                seat,
                beneficiary_account: as_beneficiary.then(|| beneficiary_pda(&self.estate, &objector.pubkey())),
                target_account,
                asset,
                objection: objection_pda(&target),
                system_program: system_program(),
            },
            heirloom::instruction::RaiseObjection { kind, target, seat_index, reason_hash: [6u8; 32] },
        );
        send(&mut self.svm, i, &[objector])
    }

    /// Objection raised by the monitor of `seat_index` (one per seat in these tests).
    fn object(&mut self, people: &People, kind: TargetKind, target: Pubkey, seat_index: u8, target_account: Option<Pubkey>, asset: Option<Pubkey>) -> Result<(), String> {
        let m = people.monitors[seat_index as usize].insecure_clone();
        let seat = Some(seat_pda(&self.estate, seat_index));
        self.raise_objection(&m, kind, target, seat_index, seat, false, target_account, asset)
    }

    fn vote_objection(
        &mut self,
        voter: &Keypair,
        target: Pubkey,
        uphold: bool,
        voter_seat: Option<Pubkey>,
        target_account: Option<Pubkey>,
        asset: Option<Pubkey>,
    ) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::VoteObjection {
                voter: voter.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                objection: objection_pda(&target),
                voter_seat,
                target_account,
                asset,
            },
            heirloom::instruction::VoteObjection { uphold },
        );
        send(&mut self.svm, i, &[voter])
    }

    fn objection(&self, target: &Pubkey) -> Objection {
        fetch(&self.svm, &objection_pda(target))
    }

    fn approve_claim_by(&mut self, signer: &Keypair, claim: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ApproveClaim {
                verifier: signer.pubkey(),
                estate: self.estate,
                claim,
                payer: signer.pubkey(),
                approval_stamp: stamp_pda(&claim),
                system_program: system_program(),
            },
            heirloom::instruction::ApproveClaim {},
        );
        send(&mut self.svm, i, &[signer])
    }

    fn set_fallback(&mut self, recipients: [Pubkey; 4]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetFallback {
                owner: self.owner.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
            },
            heirloom::instruction::SetFallback { recipients },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn report_fallback_death(&mut self, index: u8) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReportFallbackDeath {
                reporter: self.stranger.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
            },
            heirloom::instruction::ReportFallbackDeath { index, cert_hash: [7u8; 32] },
        );
        let s = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&s])
    }

    fn review_fallback_death(&mut self, index: u8, approve: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReviewFallbackDeath {
                agent: self.agent.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
            },
            heirloom::instruction::ReviewFallbackDeath { index, approve, report_hash: [9u8; 32] },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn start_fallback(&mut self) -> Result<(), String> {
        let e = self.estate;
        let i = ix(
            heirloom::accounts::StartFallback {
                estate: e,
                guard: guard_pda(&e),
                seat0: seat_pda(&e, 0),
                seat1: seat_pda(&e, 1),
                seat2: seat_pda(&e, 2),
                caller: self.stranger.pubkey(),
            },
            heirloom::instruction::StartFallback {},
        );
        let s = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&s])
    }

    fn lapse_objection(&mut self, target: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::LapseObjection {
                estate: self.estate,
                guard: guard_pda(&self.estate),
                objection: objection_pda(&target),
                caller: self.stranger.pubkey(),
            },
            heirloom::instruction::LapseObjection {},
        );
        let s = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&s])
    }

    fn execute_fallback(&mut self, recipient: Pubkey) -> Result<(), String> {
        let e = self.estate;
        let guard = guard_pda(&e);
        let i = ix(
            heirloom::accounts::ExecuteFallback {
                payer: self.stranger.pubkey(),
                estate: e,
                guard,
                seat0: seat_pda(&e, 0),
                seat1: seat_pda(&e, 1),
                seat2: seat_pda(&e, 2),
                objection: objection_pda(&guard),
                recipient,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                recipient_usdt: ata(&recipient, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
            },
            heirloom::instruction::ExecuteFallback {},
        );
        let s = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&s])
    }
}

/// Configured estate with a Guard and 3 Seats: seat i held by verifier i, backups people.backups[i],
/// monitor people.monitors[i].
fn guarded(env: &mut Env) -> People {
    let people = People::new(&mut env.svm);
    env.init_guard().unwrap();
    for i in 0..3u8 {
        let b = [people.backups[i as usize][0].pubkey(), people.backups[i as usize][1].pubkey()];
        let m = [people.monitors[i as usize].pubkey(), d()];
        env.init_seat(i, b, m).unwrap();
    }
    people
}

fn guardian_env() -> (Env, People) {
    let mut env = Env::configured();
    let people = guarded(&mut env);
    (env, people)
}

/// Guarded, kid1 tuition rule (rule 0) and the estate unlocked.
fn guarded_claims() -> (Env, People, Pubkey) {
    let (mut env, people) = guardian_env();
    let valid_until = now(&env.svm) + 365 * DAY;
    let kid1 = env.kid1.pubkey();
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until);
    env.unlock();
    (env, people, rule)
}

/// 100 USD₮ claim: submitted, agent-approved, approved by verifier 0 (seat 0, threshold 1).
fn approved_claim(env: &mut Env, rule: Pubkey) -> Pubkey {
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    claim
}

// ------------------------------------------------------------------- objections on claims

#[test]
fn monitor_objection_blocks_claim_and_upheld_rejects_it() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    let stamp: ApprovalStamp = fetch(&env.svm, &stamp_pda(&claim));
    assert_eq!((stamp.approved_at, stamp.seat_index), (now(&env.svm), 0));

    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    assert_eq!(env.guard().open_objections, 1);
    let o = env.objection(&claim);
    assert_eq!((o.status, o.kind, o.seat_index, o.monitor), (ObjectionStatus::Open, TargetKind::Claim, 0, people.monitors[0].pubkey()));
    // One open objection per target.
    expect_err(env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None), HeirloomError::ObjectionOpen);

    warp(&mut env.svm, WINDOW);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);

    // The watched holder can't vote on an objection about their own approval.
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    expect_err(env.vote_objection(&v0, claim, false, None, Some(claim), None), HeirloomError::NotVerifier);
    env.vote_objection(&v1, claim, true, None, Some(claim), None).unwrap();
    expect_err(env.vote_objection(&v1, claim, true, None, Some(claim), None), HeirloomError::AlreadyApproved);
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Open);
    env.vote_objection(&v2, claim, true, None, Some(claim), None).unwrap();

    assert_eq!(env.objection(&claim).status, ObjectionStatus::Upheld);
    assert_eq!(env.guard().open_objections, 0);
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Rejected);
    expect_err(env.execute_claim(rule, claim), HeirloomError::BadStatus);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn dismissed_objection_lets_claim_execute_after_window() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    let (v1, v2) = (env.v(1), env.v(2));
    env.vote_objection(&v1, claim, false, None, Some(claim), None).unwrap();
    env.vote_objection(&v2, claim, false, None, Some(claim), None).unwrap();
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Dismissed);
    assert_eq!(env.guard().open_objections, 0);

    // Dismissed, but the window still runs from the approval.
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
    assert_eq!(balance(&env.svm, &ata(&env.university.pubkey(), &env.usdt_mint)), 100 * USDT);
}

#[test]
fn guarded_claim_waits_for_objection_window() {
    let (mut env, _people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW - 1);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, 1);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn only_the_seats_monitor_can_object() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    let stranger = env.kp(&env.stranger);
    let seat0 = Some(seat_pda(&env.estate, 0));
    let seat1 = Some(seat_pda(&env.estate, 1));
    expect_err(
        env.raise_objection(&stranger, TargetKind::Claim, claim, 0, seat0, false, Some(claim), None),
        HeirloomError::NotMonitor,
    );
    // Seat 1's monitor can't object to seat 0's approval...
    let m1 = env.kp(&people.monitors[1]);
    expect_err(
        env.raise_objection(&m1, TargetKind::Claim, claim, 0, seat1, false, Some(claim), None),
        HeirloomError::NotMonitor,
    );
    // ...nor to a claim its own holder didn't approve.
    expect_err(
        env.raise_objection(&m1, TargetKind::Claim, claim, 1, seat1, false, Some(claim), None),
        HeirloomError::BadStatus,
    );
}

#[test]
fn owner_alive_decides_an_objection_alone() {
    let mut env = Env::configured();
    let people = guarded(&mut env);
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    let claim = env.submit_claim(true, rule, uni, 300 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();

    env.owner_approve_claim(rule, claim).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
    let owner = env.kp(&env.owner);
    env.vote_objection(&owner, claim, false, None, Some(claim), None).unwrap();
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Dismissed);
    // Owner-approved while alive: no objection window.
    env.execute_claim(rule, claim).unwrap();
}

// ------------------------------------------------------------------- objections on unlock and sales

#[test]
fn unlock_objection_blocks_finalize_and_upheld_clears_death_claim() {
    let (mut env, people) = guardian_env();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);

    let estate = env.estate;
    env.object(&people, TargetKind::Unlock, estate, 0, None, None).unwrap();
    assert_eq!(env.objection(&estate).seat_index, 255);
    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::ObjectionOpen);

    let (v1, v2) = (env.v(1), env.v(2));
    env.vote_objection(&v1, estate, true, None, None, None).unwrap();
    env.vote_objection(&v2, estate, true, None, None, None).unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::Active);
    assert_eq!(e.death_cert_hash, [0u8; 32]);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);
}

#[test]
fn sale_objection_blocks_accept_until_relisted() {
    let mut s = Sale::build(true);
    let people = s.people.take().unwrap();
    let asset = s.asset;
    s.place_offer(2, 9_500 * USDT).unwrap();
    s.env.object(&people, TargetKind::Sale, asset, 0, Some(asset), None).unwrap();
    expect_err(s.accept_offer(2), HeirloomError::ObjectionOpen);

    let (v1, v2) = (s.env.v(1), s.env.v(2));
    s.env.vote_objection(&v1, asset, true, None, Some(asset), None).unwrap();
    s.env.vote_objection(&v2, asset, true, None, Some(asset), None).unwrap();
    let a: Asset = fetch(&s.env.svm, &asset);
    assert_eq!(a.status, AssetStatus::Held);
    expect_err(s.accept_offer(2), HeirloomError::BadStatus);

    // Relisted: the upheld objection no longer blocks.
    let i = ix(
        heirloom::accounts::ListAsset { authority: s.env.agent.pubkey(), estate: s.env.estate, asset },
        heirloom::instruction::ListAsset { duration_secs: DAY },
    );
    send(&mut s.env.svm, i, &[&s.env.agent]).unwrap();
    s.accept_offer(2).unwrap();
}

#[test]
fn hardship_objection_pauses_hardship_sale_and_upheld_restores_floor() {
    let mut s = Sale::build(true);
    let people = s.people.take().unwrap();
    let asset = s.asset;
    s.place_offer(1, 7_500 * USDT).unwrap();
    s.approved_hardship(); // verifiers 0 and 2 approve
    let hardship = hardship_pda(&asset, &s.env.kid2.pubkey());

    s.env.object(&people, TargetKind::Hardship, hardship, 0, Some(hardship), Some(asset)).unwrap();
    expect_err(s.accept_offer(1), HeirloomError::ObjectionOpen);

    let (v1, v2) = (s.env.v(1), s.env.v(2));
    s.env.vote_objection(&v1, hardship, true, None, Some(hardship), Some(asset)).unwrap();
    s.env.vote_objection(&v2, hardship, true, None, Some(hardship), Some(asset)).unwrap();
    let h: Hardship = fetch(&s.env.svm, &hardship);
    assert_eq!(h.status, HardshipStatus::Rejected);
    let a: Asset = fetch(&s.env.svm, &asset);
    assert_eq!(a.hardship_beneficiary, None);
    expect_err(s.accept_offer(1), HeirloomError::BelowFloor);
}

// ------------------------------------------------------------------- succession

#[test]
fn succession_first_backup_takes_the_seat_and_can_approve() {
    let (mut env, people) = guardian_env();
    let valid_until = now(&env.svm) + 365 * DAY;
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until);

    let reporter = env.kp(&env.kid1);
    let (v0, v2) = (env.v(0), env.v(2));
    expect_err(env.review_seat_death(2, true), HeirloomError::NoSuccessionPending);
    env.report_seat_death(&reporter, 2).unwrap();
    expect_err(env.report_seat_death(&reporter, 2), HeirloomError::SuccessionPending);
    expect_err(env.confirm_seat_death(&v0, 2), HeirloomError::AgentNotApproved);
    env.review_seat_death(2, true).unwrap();
    expect_err(env.finalize_succession(2), HeirloomError::NotConfirmer);
    env.confirm_seat_death(&v0, 2).unwrap();
    expect_err(env.finalize_succession(2), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();

    let heir = env.kp(&people.backups[2][0]);
    let seat = env.seat(2);
    assert_eq!(seat.holder, heir.pubkey());
    assert_eq!(seat.backups, [people.backups[2][1].pubkey(), d()]);
    assert_eq!(seat.monitors[0], people.monitors[2].pubkey());
    assert_eq!((seat.generation, seat.vacant, seat.death_cert_hash), (1, false, [0u8; 32]));
    assert_eq!(env.estate_state().verifiers[2], heir.pubkey());

    // The successor approves at once; the late holder no longer can.
    env.unlock();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    expect_err(env.approve_claim_by(&v2, claim), HeirloomError::NotVerifier);
    env.approve_claim_by(&heir, claim).unwrap();
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.approvals, 0b100);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn holder_vetoes_their_reported_death() {
    let (mut env, _people) = guardian_env();
    let (reporter, stranger) = (env.kp(&env.kid1), env.kp(&env.stranger));
    let (v0, v2) = (env.v(0), env.v(2));
    expect_err(env.veto_seat_death(&v2, 2), HeirloomError::NoSuccessionPending);
    env.report_seat_death(&reporter, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&v0, 2).unwrap();
    expect_err(env.veto_seat_death(&stranger, 2), HeirloomError::NotVerifier);
    env.veto_seat_death(&v2, 2).unwrap();

    let seat = env.seat(2);
    assert_eq!(seat.holder, v2.pubkey());
    assert_eq!((seat.death_cert_hash, seat.death_verdict, seat.death_pending_since), ([0u8; 32], Verdict::Pending, 0));
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(2), HeirloomError::NoSuccessionPending);
}

#[test]
fn reporter_and_outsiders_cannot_confirm_a_seat_death() {
    let (mut env, _people) = guardian_env();
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    let stranger = env.kp(&env.stranger);
    // Nobody reports their own death.
    expect_err(env.report_seat_death(&v2, 2), HeirloomError::BadStatus);
    env.report_seat_death(&v0, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    expect_err(env.confirm_seat_death(&v0, 2), HeirloomError::NotConfirmer);
    expect_err(env.confirm_seat_death(&stranger, 2), HeirloomError::NotConfirmer);
    env.confirm_seat_death(&v1, 2).unwrap();
    expect_err(env.confirm_seat_death(&v1, 2), HeirloomError::AlreadyApproved);
}

#[test]
fn agent_rejection_clears_seat_death_report() {
    let (mut env, _people) = guardian_env();
    let reporter = env.kp(&env.kid1);
    let v0 = env.v(0);
    env.report_seat_death(&reporter, 2).unwrap();
    env.review_seat_death(2, false).unwrap();
    assert_eq!(env.seat(2).death_cert_hash, [0u8; 32]);
    expect_err(env.confirm_seat_death(&v0, 2), HeirloomError::NoSuccessionPending);
}

#[test]
fn no_backups_leaves_the_seat_vacant() {
    let (mut env, _people) = guardian_env();
    let owner = env.kp(&env.owner);
    let v1 = env.v(1);
    env.set_seat_backups(&owner, 0, [d(), d()]).unwrap();
    env.succeed(0, &v1);

    let seat = env.seat(0);
    assert!(seat.vacant);
    assert_eq!((seat.holder, seat.generation), (d(), 1));
    assert_eq!(env.estate_state().verifiers[0], d());
    let reporter = env.kp(&env.kid1);
    expect_err(env.report_seat_death(&reporter, 0), HeirloomError::SeatVacant);
}

#[test]
fn last_holder_confirmed_by_second_backup_never_the_first() {
    let (mut env, people) = guardian_env();
    let owner = env.kp(&env.owner);
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    env.set_seat_backups(&owner, 0, [d(), d()]).unwrap();
    env.set_seat_backups(&owner, 1, [d(), d()]).unwrap();
    env.succeed(0, &v1);
    env.succeed(1, &v2);
    assert!(env.seat(0).vacant && env.seat(1).vacant);

    // Seat 2: no other living holder, so backups[1] (or a monitor) confirms; backups[0] can't.
    let reporter = env.kp(&env.kid1);
    env.report_seat_death(&reporter, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    let (first, second) = (env.kp(&people.backups[2][0]), env.kp(&people.backups[2][1]));
    expect_err(env.confirm_seat_death(&first, 2), HeirloomError::NotConfirmer);
    expect_err(env.confirm_seat_death(&v0, 2), HeirloomError::NotConfirmer);
    env.confirm_seat_death(&second, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();
    assert_eq!(env.seat(2).holder, first.pubkey());
}

#[test]
fn chain_of_succession_twice_reaches_generation_two() {
    let (mut env, people) = guardian_env();
    let v0 = env.v(0);
    env.succeed(2, &v0);
    let heir = env.kp(&people.backups[2][0]);
    assert_eq!(env.seat(2).holder, heir.pubkey());

    // The new holder names their own backup.
    let next = funded(&mut env.svm);
    let owner_pk = env.owner.pubkey();
    expect_err(env.set_seat_backups(&heir, 2, [owner_pk, d()]), HeirloomError::BadBackup);
    env.set_seat_backups(&heir, 2, [next.pubkey(), d()]).unwrap();

    env.succeed(2, &v0);
    let seat = env.seat(2);
    assert_eq!((seat.holder, seat.generation, seat.backups), (next.pubkey(), 2, [d(), d()]));
    assert_eq!(env.estate_state().verifiers[2], next.pubkey());
}

#[test]
fn succession_objection_blocks_and_upheld_clears_it() {
    let (mut env, people) = guardian_env();
    let reporter = env.kp(&env.kid1);
    let (v0, v1) = (env.v(0), env.v(1));
    env.report_seat_death(&reporter, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&v0, 2).unwrap();
    let seat = seat_pda(&env.estate, 2);
    env.object(&people, TargetKind::Succession, seat, 2, None, None).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(2), HeirloomError::ObjectionOpen);
    env.vote_objection(&v0, seat, true, None, Some(seat), None).unwrap();
    env.vote_objection(&v1, seat, true, None, Some(seat), None).unwrap();
    assert_eq!(env.seat(2).death_cert_hash, [0u8; 32]);
    expect_err(env.finalize_succession(2), HeirloomError::NoSuccessionPending);
}

#[test]
fn seat_and_fallback_settings_are_validated() {
    let (mut env, people) = guardian_env();
    let (owner, stranger, v0) = (env.kp(&env.owner), env.kp(&env.stranger), env.v(0));
    let (o, v1) = (env.owner.pubkey(), env.verifiers[1].pubkey());
    let x = people.backups[0][0].pubkey();

    expect_err(env.set_seat_backups(&owner, 0, [o, d()]), HeirloomError::BadBackup);
    expect_err(env.set_seat_backups(&owner, 0, [v1, d()]), HeirloomError::BadBackup);
    expect_err(env.set_seat_backups(&owner, 0, [v0.pubkey(), d()]), HeirloomError::BadBackup);
    expect_err(env.set_seat_backups(&owner, 0, [x, x]), HeirloomError::BadBackup);
    expect_err(env.set_seat_backups(&stranger, 0, [x, d()]), HeirloomError::NotOwner);
    // The holder may set their own backups; a lone second entry is moved to the front.
    env.set_seat_backups(&v0, 0, [d(), x]).unwrap();
    assert_eq!(env.seat(0).backups, [x, d()]);

    expect_err(env.set_seat_monitors(0, [v0.pubkey(), d()]), HeirloomError::BadMonitor);
    expect_err(env.set_seat_monitors(0, [x, x]), HeirloomError::BadMonitor);
    env.set_seat_monitors(0, [people.monitors[1].pubkey(), d()]).unwrap();

    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    expect_err(env.set_fallback([k1, o, d(), d()]), HeirloomError::BadFallback);
    expect_err(env.set_fallback([k1, k1, d(), d()]), HeirloomError::BadFallback);
    env.set_fallback([k1, k2, d(), d()]).unwrap();
    assert_eq!(env.guard().fallback, [k1, k2, d(), d()]);
}

// ------------------------------------------------------------------- fallback plan

/// Guarded estate with the fallback list [kid1, kid2, executor] and the owner's death claim agent-approved.
fn fallback_env() -> (Env, People) {
    let (mut env, people) = guardian_env();
    let (k1, k2, ex) = (env.kid1.pubkey(), env.kid2.pubkey(), env.executor.pubkey());
    env.set_fallback([k1, k2, ex, d()]).unwrap();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    (env, people)
}

/// Every seat holder dies with no backups left.
fn vacate_all(env: &mut Env, people: &People) {
    let owner = env.kp(&env.owner);
    for i in 0..3 {
        env.set_seat_backups(&owner, i, [d(), d()]).unwrap();
    }
    let (v1, v2) = (env.v(1), env.v(2));
    env.succeed(0, &v1);
    env.succeed(1, &v2);
    let m2 = env.kp(&people.monitors[2]);
    env.succeed(2, &m2);
    assert!((0..3).all(|i| env.seat(i).vacant));
}

#[test]
fn fallback_blocked_while_a_seat_is_filled_or_owner_alive() {
    let (mut env, people) = fallback_env();
    expect_err(env.start_fallback(), HeirloomError::SeatsNotVacant);

    // All seats vacant but no proof of the owner's death: not ready.
    let (mut env2, people2) = guardian_env();
    let k1 = env2.kid1.pubkey();
    env2.set_fallback([k1, d(), d(), d()]).unwrap();
    vacate_all(&mut env2, &people2);
    expect_err(env2.start_fallback(), HeirloomError::FallbackNotReady);

    // Two of three vacant is still not enough.
    let owner = env.kp(&env.owner);
    env.set_seat_backups(&owner, 0, [d(), d()]).unwrap();
    env.set_seat_backups(&owner, 1, [d(), d()]).unwrap();
    let (v1, v2) = (env.v(1), env.v(2));
    env.succeed(0, &v1);
    env.succeed(1, &v2);
    expect_err(env.start_fallback(), HeirloomError::SeatsNotVacant);
    let _ = people;
}

#[test]
fn fallback_pays_whole_vault_to_first_recipient() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);
    env.start_fallback().unwrap();
    expect_err(env.start_fallback(), HeirloomError::BadStatus);
    expect_err(env.execute_fallback(k1), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, FALLBACK_WAIT);
    expect_err(env.execute_fallback(k2), HeirloomError::NoFallbackRecipient);
    env.execute_fallback(k1).unwrap();

    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_000 * USDT);
    assert_eq!(balance(&env.svm, &env.vault()), 0);
    assert!(env.guard().fallback_done);
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackDone);
}

#[test]
fn fallback_skips_a_recipient_proven_dead() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    env.start_fallback().unwrap();
    env.report_fallback_death(0).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    env.review_fallback_death(0, true).unwrap();
    let g = env.guard();
    assert_eq!(g.fallback_dead, 0b1);
    // The recipient changed, so the countdown restarted.
    assert_eq!(g.fallback_started_at, now(&env.svm));
    expect_err(env.report_fallback_death(0), HeirloomError::BadStatus);

    warp(&mut env.svm, FALLBACK_WAIT / 2);
    expect_err(env.execute_fallback(k2), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    expect_err(env.execute_fallback(k1), HeirloomError::NoFallbackRecipient);
    env.execute_fallback(k2).unwrap();
    assert_eq!(balance(&env.svm, &ata(&k2, &env.usdt_mint)), 5_000 * USDT);
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 0);
}

#[test]
fn open_objection_blocks_execute_fallback() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let guard = guard_pda(&env.estate);
    let (kid2, stranger) = (env.kp(&env.kid2), env.kp(&env.stranger));
    let k1 = env.kid1.pubkey();

    expect_err(
        env.raise_objection(&stranger, TargetKind::Fallback, guard, 255, None, false, None, None),
        HeirloomError::NotMonitor,
    );
    // A beneficiary may object to the fallback (raised 10 s in, so it is still open, not lapsed,
    // when the countdown ends).
    warp(&mut env.svm, 10);
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT - 10);
    expect_err(env.execute_fallback(k1), HeirloomError::ObjectionOpen);

    // Every holder is gone, so monitors decide; the objector can't vote.
    let (m0, m1) = (env.kp(&people.monitors[0]), env.kp(&people.monitors[1]));
    let (s0, s1) = (Some(seat_pda(&env.estate, 0)), Some(seat_pda(&env.estate, 1)));
    expect_err(env.vote_objection(&kid2, guard, false, None, None, None), HeirloomError::NotVerifier);
    expect_err(env.vote_objection(&m0, guard, true, None, None, None), HeirloomError::NotMonitor);
    env.vote_objection(&m0, guard, true, s0, None, None).unwrap();
    env.vote_objection(&m1, guard, true, s1, None, None).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Upheld);
    assert_eq!(env.guard().fallback_started_at, 0);
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);

    // A fresh start runs the full wait again.
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    env.execute_fallback(k1).unwrap();
}

#[test]
fn owner_heartbeat_voids_a_started_fallback() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    warp(&mut env.svm, 10);
    let i = ix(
        heirloom::accounts::Heartbeat { owner: env.owner.pubkey(), estate: env.estate },
        heirloom::instruction::Heartbeat {},
    );
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    let k1 = env.kid1.pubkey();
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);
}

// ------------------------------------------------------------------- asset photos

#[test]
fn asset_media_set_by_owner_or_agent() {
    let mut env = Env::configured();
    let owner = env.owner.pubkey();
    let nft_mint = create_mint(&mut env.svm, &owner, 1, 0);
    let owner_nft = fund_ata(&mut env.svm, &owner, &nft_mint, 1);
    let asset = asset_pda(&env.estate, &nft_mint);
    let i = ix(
        heirloom::accounts::RegisterAsset {
            owner,
            estate: env.estate,
            nft_mint,
            owner_nft,
            nft_escrow: ata(&env.estate, &nft_mint),
            asset,
            token_program: token_program(),
            associated_token_program: ata_program(),
            system_program: system_program(),
        },
        heirloom::instruction::RegisterAsset {
            floor_price: FLOOR,
            hardship_floor: HARDSHIP_FLOOR,
            asking_price: ASKING,
            proceeds_to: env.executor.pubkey(),
            doc_hash: [3u8; 32],
        },
    );
    send(&mut env.svm, i, &[&env.owner]).unwrap();

    let set = |env: &Env, who: &Keypair, count: u8| {
        ix(
            heirloom::accounts::SetAssetMedia {
                authority: who.pubkey(),
                estate: env.estate,
                asset,
                media: media_pda(&asset),
                system_program: system_program(),
            },
            heirloom::instruction::SetAssetMedia { kind: AssetKind::Motorbike, photos_root: [count; 32], photo_count: count },
        )
    };
    let (o, a, s) = (env.kp(&env.owner), env.kp(&env.agent), env.kp(&env.stranger));
    // At most 24 photos (MAX_PHOTOS): 25 is refused, 24 is accepted.
    let i = set(&env, &o, 25);
    expect_err(send(&mut env.svm, i, &[&o]), HeirloomError::InvalidAmount);
    let i = set(&env, &o, 24);
    send(&mut env.svm, i, &[&o]).unwrap();
    let m: AssetMedia = fetch(&env.svm, &media_pda(&asset));
    assert_eq!(m.photo_count, 24);
    let i = set(&env, &s, 3);
    expect_err(send(&mut env.svm, i, &[&s]), HeirloomError::NotOwner);
    let i = set(&env, &o, 3);
    send(&mut env.svm, i, &[&o]).unwrap();
    let m: AssetMedia = fetch(&env.svm, &media_pda(&asset));
    assert_eq!((m.asset, m.kind, m.photo_count, m.photos_root), (asset, AssetKind::Motorbike, 3, [3u8; 32]));

    // After unlock only the agent can update the photos.
    env.unlock();
    let i = set(&env, &o, 5);
    expect_err(send(&mut env.svm, i, &[&o]), HeirloomError::NotOwner);
    let i = set(&env, &a, 5);
    send(&mut env.svm, i, &[&a]).unwrap();
    let m: AssetMedia = fetch(&env.svm, &media_pda(&asset));
    assert_eq!(m.photo_count, 5);
}

// ------------------------------------------------------------------- fallback objections lapse (funds never locked forever)

#[test]
fn fallback_objection_with_no_monitors_lapses_and_fallback_pays() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    for i in 0..3 {
        env.set_seat_monitors(i, [d(), d()]).unwrap();
    }
    env.start_fallback().unwrap();
    let started = env.guard().fallback_started_at;
    let guard = guard_pda(&env.estate);
    let kid2 = env.kp(&env.kid2);
    let k1 = env.kid1.pubkey();

    // Raised halfway through the countdown: nobody can vote on it.
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    expect_err(env.execute_fallback(k1), HeirloomError::ObjectionOpen);
    expect_err(env.lapse_objection(guard), HeirloomError::ObjectionNotLapsed);

    // Lapses fallback_wait after it was raised; the countdown itself did not restart.
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    assert_eq!(env.guard().fallback_started_at, started);
    env.execute_fallback(k1).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Dismissed);
    assert_eq!(env.guard().open_objections, 0);
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_000 * USDT);
}

#[test]
fn tied_fallback_objection_lapses() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let started = env.guard().fallback_started_at;
    let guard = guard_pda(&env.estate);
    let kid2 = env.kp(&env.kid2);
    let k1 = env.kid1.pubkey();
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();

    let (m0, m1, m2) = (env.kp(&people.monitors[0]), env.kp(&people.monitors[1]), env.kp(&people.monitors[2]));
    let seat = |i| Some(seat_pda(&env.estate, i));
    let (s0, s1, s2) = (seat(0), seat(1), seat(2));
    env.vote_objection(&m0, guard, true, s0, None, None).unwrap();
    env.vote_objection(&m1, guard, false, s1, None, None).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Open);

    warp(&mut env.svm, FALLBACK_WAIT);
    // Too late to break the tie.
    expect_err(env.vote_objection(&m2, guard, true, s2, None, None), HeirloomError::ObjectionLapsed);
    env.lapse_objection(guard).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Dismissed);
    assert_eq!(env.guard().open_objections, 0);
    assert_eq!(env.guard().fallback_started_at, started);
    expect_err(env.lapse_objection(guard), HeirloomError::BadStatus);
    // No second objection in the same countdown.
    expect_err(
        env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None),
        HeirloomError::BadStatus,
    );
    env.execute_fallback(k1).unwrap();
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_000 * USDT);
}

#[test]
fn fallback_objection_upheld_before_lapse_resets_the_fallback() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let guard = guard_pda(&env.estate);
    let kid2 = env.kp(&env.kid2);
    let k1 = env.kid1.pubkey();
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();

    warp(&mut env.svm, FALLBACK_WAIT - 1);
    let (m0, m1) = (env.kp(&people.monitors[0]), env.kp(&people.monitors[1]));
    let (s0, s1) = (Some(seat_pda(&env.estate, 0)), Some(seat_pda(&env.estate, 1)));
    env.vote_objection(&m0, guard, true, s0, None, None).unwrap();
    env.vote_objection(&m1, guard, true, s1, None, None).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Upheld);
    assert_eq!(env.guard().fallback_started_at, 0);

    warp(&mut env.svm, FALLBACK_WAIT);
    expect_err(env.lapse_objection(guard), HeirloomError::BadStatus);
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

// =================================================================== disputes (U9, 2026-11-15)

const YEAR: i64 = 365 * DAY;

impl Env {
    fn raise_dispute(&mut self, disputer: &Keypair, kind: TargetKind, target: Pubkey, as_beneficiary: bool, reason: [u8; 32]) -> Result<(), String> {
        let target_account = (kind == TargetKind::Claim).then_some(target);
        let i = ix(
            heirloom::accounts::RaiseDispute {
                disputer: disputer.pubkey(),
                estate: self.estate,
                beneficiary_account: as_beneficiary.then(|| beneficiary_pda(&self.estate, &disputer.pubkey())),
                target_account,
                objection: objection_pda(&target),
                system_program: system_program(),
            },
            heirloom::instruction::RaiseDispute { kind, target, reason_hash: reason },
        );
        send(&mut self.svm, i, &[disputer])
    }

    /// kid2 (a beneficiary) disputes `target`.
    fn kid_disputes(&mut self, kind: TargetKind, target: Pubkey) -> Result<(), String> {
        let kid2 = self.kid2.insecure_clone();
        self.raise_dispute(&kid2, kind, target, true, [5u8; 32])
    }

    fn resolve_dispute(&mut self, verifier: &Keypair, target: Pubkey, uphold: bool, is_claim: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ResolveDispute {
                verifier: verifier.pubkey(),
                estate: self.estate,
                objection: objection_pda(&target),
                target_account: is_claim.then_some(target),
            },
            heirloom::instruction::ResolveDispute { uphold },
        );
        send(&mut self.svm, i, &[verifier])
    }

    fn set_yearly_cap(&mut self, rule: Pubkey, cap: u64, period_start: i64) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetYearlyCap {
                owner: self.owner.pubkey(),
                estate: self.estate,
                rule,
                year_cap: year_cap_pda(&rule),
                system_program: system_program(),
            },
            heirloom::instruction::SetYearlyCap { cap, period_start },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn year_cap(&self, rule: &Pubkey) -> YearCap {
        fetch(&self.svm, &year_cap_pda(rule))
    }

    /// Death claim submitted, agent-approved and attested by 2 verifiers: DeathPending.
    fn death_pending(&mut self) {
        self.submit_death_claim(1).unwrap();
        self.review_death(true).unwrap();
        self.attest_death(0).unwrap();
        self.attest_death(1).unwrap();
        assert_eq!(self.estate_state().status, EstateStatus::DeathPending);
    }
}

/// Unguarded estate, unlocked, with an agent- and verifier-approved 100 USD₮ claim on kid1's tuition rule.
fn disputed_claim_env() -> (Env, Pubkey, Pubkey) {
    let (mut env, rule) = claims_env();
    env.unlock();
    let claim = approved_claim(&mut env, rule);
    (env, rule, claim)
}

#[test]
fn beneficiary_dispute_freezes_claim_and_two_verifiers_uphold() {
    let (mut env, rule, claim) = disputed_claim_env();
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    let o = env.objection(&claim);
    assert_eq!((o.status, o.kind, o.seat_index, o.monitor), (ObjectionStatus::Open, TargetKind::Claim, 254, env.kid2.pubkey()));
    assert_eq!(o.reason_hash, [5u8; 32]);
    // Frozen: no Guard needed for a dispute to pause the payment.
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
    expect_err(env.kid_disputes(TargetKind::Claim, claim), HeirloomError::ObjectionOpen);

    let kid2 = env.kp(&env.kid2);
    expect_err(env.resolve_dispute(&kid2, claim, true, true), HeirloomError::NotVerifier);
    let (v0, v1) = (env.v(0), env.v(1));
    env.resolve_dispute(&v0, claim, true, true).unwrap();
    expect_err(env.resolve_dispute(&v0, claim, false, true), HeirloomError::AlreadyApproved);
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Open);
    env.resolve_dispute(&v1, claim, true, true).unwrap();

    assert_eq!(env.objection(&claim).status, ObjectionStatus::Upheld);
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Rejected);
    expect_err(env.execute_claim(rule, claim), HeirloomError::BadStatus);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn dismissed_dispute_lets_claim_pay_and_cannot_be_raised_again() {
    let (mut env, rule, claim) = disputed_claim_env();
    // A verifier disputes; they can't then vote on their own dispute.
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    env.raise_dispute(&v1, TargetKind::Claim, claim, false, [5u8; 32]).unwrap();
    expect_err(env.resolve_dispute(&v1, claim, false, true), HeirloomError::NotVerifier);
    env.resolve_dispute(&v0, claim, false, true).unwrap();
    env.resolve_dispute(&v2, claim, false, true).unwrap();
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Dismissed);
    expect_err(env.resolve_dispute(&v2, claim, true, true), HeirloomError::BadStatus);

    // One challenge per claim: a dismissed dispute can't be raised again to freeze it anew.
    expect_err(env.kid_disputes(TargetKind::Claim, claim), HeirloomError::BadStatus);
    env.execute_claim(rule, claim).unwrap();
    assert_eq!(balance(&env.svm, &ata(&env.university.pubkey(), &env.usdt_mint)), 100 * USDT);
}

#[test]
fn dispute_lapses_so_funds_are_never_locked() {
    let (mut env, rule, claim) = disputed_claim_env();
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    let v0 = env.v(0);
    env.resolve_dispute(&v0, claim, true, true).unwrap(); // one vote only: no decision
    warp(&mut env.svm, WAITING - 1);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
    warp(&mut env.svm, 1);
    // Lapsed after the estate's waiting period: it counts as dismissed and can no longer be voted on.
    let v1 = env.v(1);
    expect_err(env.resolve_dispute(&v1, claim, true, true), HeirloomError::DisputeLapsed);
    expect_err(env.kid_disputes(TargetKind::Claim, claim), HeirloomError::BadStatus);
    env.execute_claim(rule, claim).unwrap();
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Paid);
}

#[test]
fn only_beneficiaries_and_verifiers_can_dispute_pending_actions() {
    let (mut env, rule, claim) = disputed_claim_env();
    let stranger = env.kp(&env.stranger);
    expect_err(env.raise_dispute(&stranger, TargetKind::Claim, claim, false, [5u8; 32]), HeirloomError::NotDisputer);
    // A beneficiary must pass their Beneficiary PDA.
    let kid2 = env.kp(&env.kid2);
    expect_err(env.raise_dispute(&kid2, TargetKind::Claim, claim, false, [5u8; 32]), HeirloomError::NotDisputer);
    // A reason is required (its hash).
    expect_err(env.raise_dispute(&kid2, TargetKind::Claim, claim, true, [0u8; 32]), HeirloomError::InvalidAmount);
    // Only claims and unlocks; the estate is Unlocked, so there is no pending unlock either.
    let estate = env.estate;
    expect_err(env.kid_disputes(TargetKind::Unlock, estate), HeirloomError::BadStatus);
    // A paid claim is no longer pending.
    env.execute_claim(rule, claim).unwrap();
    expect_err(env.kid_disputes(TargetKind::Claim, claim), HeirloomError::BadStatus);
}

#[test]
fn unlock_dispute_blocks_finalize_and_upheld_clears_death_claim() {
    let mut env = Env::configured();
    env.death_pending();
    let estate = env.estate;
    warp(&mut env.svm, WAITING / 2);
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    warp(&mut env.svm, WAITING / 2);
    expect_err(env.finalize_unlock(), HeirloomError::ObjectionOpen);

    let (v0, v2) = (env.v(0), env.v(2));
    env.resolve_dispute(&v0, estate, true, false).unwrap();
    env.resolve_dispute(&v2, estate, true, false).unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::Active);
    assert_eq!(e.death_cert_hash, [0u8; 32]);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);
    // No pending unlock any more, so nothing to dispute.
    expect_err(env.kid_disputes(TargetKind::Unlock, estate), HeirloomError::BadStatus);
}

#[test]
fn unlock_dispute_once_per_waiting_period_and_dismissed_unlock_proceeds() {
    let mut env = Env::configured();
    env.death_pending();
    let estate = env.estate;
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    let (v0, v1) = (env.v(0), env.v(1));
    env.resolve_dispute(&v0, estate, false, false).unwrap();
    env.resolve_dispute(&v1, estate, false, false).unwrap();
    assert_eq!(env.objection(&estate).status, ObjectionStatus::Dismissed);
    let v2 = env.v(2);
    expect_err(env.raise_dispute(&v2, TargetKind::Unlock, estate, false, [5u8; 32]), HeirloomError::BadStatus);
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);
}

#[test]
fn new_waiting_period_can_be_disputed_again() {
    let mut env = Env::configured();
    env.death_pending();
    let estate = env.estate;
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    warp(&mut env.svm, WAITING); // lapses
    env.veto_death().unwrap(); // the owner is alive after all
    warp(&mut env.svm, 10);
    env.death_pending(); // a later death claim starts a new waiting period
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
}

#[test]
fn disputes_share_the_objection_pda_with_monitors() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    assert_eq!(env.guard().open_objections, 0); // disputes are not monitor objections
    // While the dispute is open, a monitor's objection would only duplicate the freeze.
    expect_err(env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None), HeirloomError::ObjectionOpen);
    // Monitors' voting rules don't apply to disputes.
    let v1 = env.v(1);
    expect_err(env.vote_objection(&v1, claim, true, None, Some(claim), None), HeirloomError::BadStatus);
    // After the lapse the claim has had its challenge: a monitor can't re-freeze it.
    warp(&mut env.svm, WAITING);
    expect_err(env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None), HeirloomError::BadStatus);
    env.execute_claim(rule, claim).unwrap();
}

// =================================================================== yearly caps (2026-11-15)

/// kid1's tuition: 600 per claim, 3,000 lifetime, valid 3 years; a yearly cap of 800; unlocked.
fn capped_env() -> (Env, Pubkey) {
    let mut env = Env::configured();
    let valid_until = now(&env.svm) + 3 * YEAR;
    let kid1 = env.kid1.pubkey();
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 3_000 * USDT, valid_until);
    env.set_yearly_cap(rule, 800 * USDT, 0).unwrap();
    env.unlock();
    (env, rule)
}

#[test]
fn yearly_cap_limits_claims_per_period_and_resets() {
    let (mut env, rule) = capped_env();
    let uni = env.university.pubkey();
    let start = env.year_cap(&rule).period_start;
    env.pay_claim(rule, uni, 600 * USDT);
    assert_eq!(env.year_cap(&rule).period_spent, 600 * USDT);
    // 600 + 300 > 800 for this year, though within the per-claim and lifetime caps.
    expect_err(env.submit_claim(true, rule, uni, 300 * USDT), HeirloomError::ExceedsYearlyCap);
    env.pay_claim(rule, uni, 200 * USDT);
    assert_eq!(env.year_cap(&rule).period_spent, 800 * USDT);
    expect_err(env.submit_claim(true, rule, uni, USDT), HeirloomError::ExceedsYearlyCap);

    // The next 12-month period starts from zero.
    warp(&mut env.svm, YEAR);
    env.pay_claim(rule, uni, 600 * USDT);
    let yc = env.year_cap(&rule);
    assert_eq!((yc.period_start, yc.period_spent), (start + YEAR, 600 * USDT));
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.spent_total, 1_400 * USDT);
}

#[test]
fn yearly_cap_rechecked_at_execution() {
    let (mut env, rule) = capped_env();
    let uni = env.university.pubkey();
    let a = env.submit_claim(true, rule, uni, 500 * USDT).unwrap();
    let b = env.submit_claim(true, rule, uni, 500 * USDT).unwrap();
    for c in [a, b] {
        env.review_claim(c, true).unwrap();
        env.approve_claim(c, 0).unwrap();
    }
    env.execute_claim(rule, a).unwrap();
    expect_err(env.execute_claim(rule, b), HeirloomError::ExceedsYearlyCap);
    warp(&mut env.svm, YEAR);
    env.execute_claim(rule, b).unwrap();
    assert_eq!(env.year_cap(&rule).period_spent, 500 * USDT);
}

#[test]
fn yearly_cap_is_validated_and_set_only_while_active() {
    let mut env = Env::configured();
    warp(&mut env.svm, 200 * DAY); // so that "100 days ago" is a valid time
    let valid_until = now(&env.svm) + 3 * YEAR;
    let kid1 = env.kid1.pubkey();
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 3_000 * USDT, valid_until);
    expect_err(env.set_yearly_cap(rule, 0, 0), HeirloomError::InvalidAmount);
    expect_err(env.set_yearly_cap(rule, 3_001 * USDT, 0), HeirloomError::InvalidAmount);
    let future = now(&env.svm) + DAY;
    expect_err(env.set_yearly_cap(rule, 800 * USDT, future), HeirloomError::InvalidAmount);

    // A period can start in the past (e.g. 1 January); it rolls forward when used.
    let jan = now(&env.svm) - 100 * DAY;
    env.set_yearly_cap(rule, 800 * USDT, jan).unwrap();
    assert_eq!(env.year_cap(&rule).period_start, jan);
    // Update: new cap, period kept.
    env.set_yearly_cap(rule, 900 * USDT, 0).unwrap();
    let yc = env.year_cap(&rule);
    assert_eq!((yc.cap, yc.period_start, yc.rule), (900 * USDT, jan, rule));

    // Only the owner (another signer can't produce the owner's estate PDA).
    let stranger = env.kp(&env.stranger);
    let i = ix(
        heirloom::accounts::SetYearlyCap {
            owner: stranger.pubkey(),
            estate: env.estate,
            rule,
            year_cap: year_cap_pda(&rule),
            system_program: system_program(),
        },
        heirloom::instruction::SetYearlyCap { cap: 3_000 * USDT, period_start: 0 },
    );
    assert!(send(&mut env.svm, i, &[&stranger]).is_err());

    env.unlock();
    expect_err(env.set_yearly_cap(rule, 3_000 * USDT, 0), HeirloomError::BadStatus);
}

#[test]
fn yearly_cap_applies_to_scheduled_payments() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 3 * YEAR;
    let first_due = now(&env.svm);
    let month = 30 * DAY;
    // Living plan: 100 a month to the university; at most 250 a year.
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 3_000 * USDT, valid_until, true, 100 * USDT, month, first_due, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    // The cap must cover at least one instalment.
    expect_err(env.set_yearly_cap(rule, 99 * USDT, 0), HeirloomError::InvalidAmount);
    env.set_yearly_cap(rule, 250 * USDT, 0).unwrap();

    env.execute_scheduled(rule).unwrap();
    warp(&mut env.svm, month);
    env.execute_scheduled(rule).unwrap();
    warp(&mut env.svm, month);
    expect_err(env.execute_scheduled(rule), HeirloomError::ExceedsYearlyCap);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.next_due, first_due + 2 * month); // the instalment waits
    warp(&mut env.svm, YEAR - 2 * month);
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 300 * USDT);
    assert_eq!(env.year_cap(&rule).period_spent, 100 * USDT);
}

// =================================================================== fee sponsorship (2026-11-15)

/// Permissionless calls (finalize_unlock, finalize_succession, start_fallback, lapse_objection) take any
/// wallet as `caller`, so a sponsor can be the fee payer while a wallet with no SOL signs.
#[test]
fn permissionless_calls_can_be_sponsored() {
    let mut env = Env::configured();
    env.death_pending();
    warp(&mut env.svm, WAITING);
    let sponsor = funded(&mut env.svm);
    let caller = Keypair::new(); // no SOL at all
    let i = ix(
        heirloom::accounts::FinalizeUnlock { estate: env.estate, objection: objection_pda(&env.estate), caller: caller.pubkey() },
        heirloom::instruction::FinalizeUnlock {},
    );
    // The caller must sign.
    let mut unsigned = i.clone();
    unsigned.accounts.iter_mut().for_each(|m| m.is_signer = false);
    expect_err_any(send(&mut env.svm, unsigned, &[&sponsor]));
    send(&mut env.svm, i, &[&sponsor, &caller]).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);
}

fn expect_err_any(res: Result<(), String>) {
    assert!(res.is_err(), "expected the transaction to fail");
}

#[test]
fn sponsored_finalize_succession_and_start_fallback() {
    let (mut env, people) = guardian_env();
    // Seat 2's holder dies; the first backup takes over, finalized by a no-SOL wallet with a sponsor paying.
    let kid1 = env.kp(&env.kid1);
    let v0 = env.v(0);
    env.report_seat_death(&kid1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&v0, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    let sponsor = funded(&mut env.svm);
    let caller = Keypair::new();
    let seat = seat_pda(&env.estate, 2);
    let i = ix(
        heirloom::accounts::FinalizeSuccession {
            estate: env.estate,
            guard: guard_pda(&env.estate),
            seat,
            objection: objection_pda(&seat),
            caller: caller.pubkey(),
        },
        heirloom::instruction::FinalizeSuccession { index: 2 },
    );
    send(&mut env.svm, i, &[&sponsor, &caller]).unwrap();
    assert_eq!(env.seat(2).holder, people.backups[2][0].pubkey());

    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    let sponsor = funded(&mut env.svm);
    let caller = Keypair::new();
    let e = env.estate;
    let i = ix(
        heirloom::accounts::StartFallback {
            estate: e,
            guard: guard_pda(&e),
            seat0: seat_pda(&e, 0),
            seat1: seat_pda(&e, 1),
            seat2: seat_pda(&e, 2),
            caller: caller.pubkey(),
        },
        heirloom::instruction::StartFallback {},
    );
    send(&mut env.svm, i, &[&sponsor, &caller]).unwrap();
    assert!(env.guard().fallback_started_at > 0);
}
