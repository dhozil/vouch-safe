import json
from datetime import datetime, timedelta, timezone

import pytest

GEN = 10 ** 18
BPS = 10_000
BASE = datetime(2031, 3, 1, tzinfo=timezone.utc)
BASE_ISO = BASE.isoformat()


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def hx(addr) -> str:
    if isinstance(addr, (bytes, bytearray)):
        from genlayer.py.types import Address

        return Address(bytes(addr)).as_hex
    return addr.as_hex


@pytest.fixture(autouse=True)
def pinned_clock(direct_vm):
    direct_vm.warp(BASE_ISO)
    return direct_vm


def jump(direct_vm, days: int) -> None:
    direct_vm.warp(iso(BASE + timedelta(days=days)))


def as_user(direct_vm, addr, value: int = 0):
    class _Ctx:
        def __enter__(self):
            self.sender = direct_vm.sender
            self.value = direct_vm.value
            direct_vm.sender = addr
            direct_vm.value = value
            return direct_vm

        def __exit__(self, *exc):
            direct_vm.sender = self.sender
            direct_vm.value = self.value
            return False

    return _Ctx()


ATTEST_OK = {
    "is_manifest": True,
    "data_policy_present": True,
    "security_contact_present": True,
    "autonomy_level": "AUTONOMOUS",
    "summary": "Manifest names the operator wallet and states a retention policy.",
}

UNDERWRITE_ACCEPT = {
    "decision": "ACCEPT",
    "risk_score": 30,
    "data_leak_risk": 35,
    "confidence": 82,
    "exclusions": ["trading losses", "sanctioned counterparties"],
    "conditions": ["keep the data policy published", "report incidents within 72h"],
    "rationale": "Manifest and on-chain record support both perils at a moderate risk.",
}

UNDERWRITE_DECLINE = {
    "decision": "DECLINE",
    "risk_score": 91,
    "data_leak_risk": 88,
    "confidence": 88,
    "exclusions": [],
    "conditions": [],
    "rationale": "Manifest cannot be tied to the declared capabilities.",
}

CLAIM_PAY = {
    "verdict": "PAY",
    "covered_peril": "MISBEHAVIOR",
    "payout_ratio_bps": 8000,
    "fraud_suspected": False,
    "confidence": 84,
    "evidence_quality": 78,
    "rationale": "Incident report shows the agent moved funds outside its mandate.",
    "cited_sources": ["https://evidence.example/incident-1"],
}

CLAIM_FRAUD = {
    "verdict": "PAY",
    "covered_peril": "MISBEHAVIOR",
    "payout_ratio_bps": 10000,
    "fraud_suspected": True,
    "confidence": 90,
    "evidence_quality": 20,
    "rationale": "Screenshots are reused from an unrelated incident.",
    "cited_sources": [],
}

CLAIM_UNDETERMINED = {
    "verdict": "UNDETERMINED",
    "covered_peril": "NONE",
    "payout_ratio_bps": 0,
    "fraud_suspected": False,
    "confidence": 20,
    "evidence_quality": 0,
    "rationale": "No source could be read.",
    "cited_sources": [],
}

APPEAL_DENY = {
    "verdict": "DENY",
    "covered_peril": "NONE",
    "payout_ratio_bps": 0,
    "fraud_suspected": False,
    "confidence": 86,
    "evidence_quality": 70,
    "rationale": "The timeline contradicts the claim: the action predates the policy.",
    "cited_sources": [],
}

CLAIM_URL = "https://evidence.example/incident"
CORROBORATION_URL = "https://corroborate.example/report"
CLAIM_EVIDENCE = CLAIM_URL + "\n" + CORROBORATION_URL
MANIFEST_URL = "https://agents.example/helios"

INCIDENT = (
    "On 2031-03-02 the Helios agent executed a transfer of 500 GEN out of the "
    "treasury wallet it was only authorised to read, without operator approval."
)


def manifest_for(agent_name: str, wallet: str, data_policy: bool = True) -> str:
    policy = "Data policy: user records are encrypted and retained for 30 days." if data_policy else ""
    return (
        "# " + agent_name + "\n"
        "Autonomous market-making agent for GEN pairs.\n"
        "Operator wallet: " + wallet + "\n"
        "Security contact: security@agents.example\n"
        + policy + "\n"
        "Capabilities: quote, swap, rebalance.\n"
    )


def mock_sources(
    direct_vm,
    wallet: str = "",
    data_policy: bool = True,
    attest=ATTEST_OK,
    underwrite=UNDERWRITE_ACCEPT,
    claim=CLAIM_PAY,
    appeal=APPEAL_DENY,
    evidence_status: int = 200,
    corroboration_status: int = 0,
) -> None:
    direct_vm.mock_web(r"agents\.example/helios", {"status": 200, "body": manifest_for("Helios Trader", wallet, data_policy)})
    direct_vm.mock_web(r"evidence\.example/incident", {"status": evidence_status, "body": INCIDENT})
    direct_vm.mock_web(
        r"corroborate\.example/report",
        {
            "status": corroboration_status or evidence_status,
            "body": "Treasury log corroborates the unauthorised 500 GEN transfer by Helios.",
        },
    )
    direct_vm.mock_llm(r"You are the identity verifier", json.dumps(attest))
    direct_vm.mock_llm(r"You are the underwriting engine", json.dumps(underwrite))
    direct_vm.mock_llm(r"You are the independent claims adjudicator", json.dumps(claim))
    direct_vm.mock_llm(r"You are the appeals panel", json.dumps(appeal))


def deploy(direct_deploy):
    return direct_deploy("contracts/vouchsafe.py", 500, 5 * GEN)


def register(direct_vm, contract, alice, wallet: str) -> None:
    with as_user(direct_vm, alice, 10 * GEN):
        contract.register_agent(
            "helios",
            "Helios Trader",
            wallet,
            "quote, swap, rebalance",
            MANIFEST_URL,
        )


def attested_agent(direct_vm, direct_deploy, direct_alice):
    contract = deploy(direct_deploy)
    mock_sources(direct_vm, hx(direct_alice))
    register(direct_vm, contract, direct_alice, hx(direct_alice))
    contract.attest_agent("helios")
    return contract


def fund_and_bind(direct_vm, contract, direct_alice, direct_charlie):
    with as_user(direct_vm, direct_charlie, 50_000 * GEN):
        contract.fund_pool()
    with as_user(direct_vm, direct_alice):
        quote_id = contract.request_quote(
            "helios", 1_000 * GEN, 50 * GEN, 30, "MISBEHAVIOR,DATA_LEAK", "customer PII: names, emails, orders"
        )
    quote = contract.get_quote(quote_id)
    with as_user(direct_vm, direct_alice, quote["premium_atto"]):
        policy_id = contract.bind_policy(quote_id)
    return quote, policy_id


def waive(direct_vm, contract, direct_alice, claim_id: str) -> None:
    with as_user(direct_vm, direct_alice):
        contract.waive_response(claim_id)


def file_claim_as_bob(direct_vm, contract, direct_bob, policy_id: str, claimed: int = 500 * GEN) -> str:
    with as_user(direct_vm, direct_bob):
        return contract.file_claim(
            policy_id,
            "INC-2031-03-02",
            "MISBEHAVIOR",
            INCIDENT,
            claimed,
            CLAIM_EVIDENCE,
        )


# ---------------------------------------------------------------------------
# Deployment and terms
# ---------------------------------------------------------------------------
def test_terms_and_empty_pool(direct_deploy, direct_owner):
    contract = deploy(direct_deploy)
    terms = contract.get_terms()
    assert terms["operator"] == hx(direct_owner)
    assert terms["fee_bps"] == 500
    assert terms["min_bond_atto"] == 5 * GEN
    pool = contract.get_pool()
    assert pool == {
        "assets_atto": 0,
        "reserved_atto": 0,
        "free_atto": 0,
        "total_shares": 0,
        "treasury_atto": 0,
        "pending_payout_atto": 0,
        "payouts_total": 0,
        "share_price_atto": 0,
    }


# ---------------------------------------------------------------------------
# Identity registry
# ---------------------------------------------------------------------------
def test_registration_requires_bond(direct_vm, direct_deploy, direct_alice):
    contract = deploy(direct_deploy)
    with as_user(direct_vm, direct_alice, 1 * GEN):
        with direct_vm.expect_revert("[EXPECTED] bond below the minimum"):
            contract.register_agent(
                "helios", "Helios Trader", hx(direct_alice), "quote", MANIFEST_URL
            )


def test_registration_is_one_agent_per_operator(direct_vm, direct_deploy, direct_alice):
    contract = deploy(direct_deploy)
    register(direct_vm, contract, direct_alice, hx(direct_alice))
    with as_user(direct_vm, direct_alice, 10 * GEN):
        with direct_vm.expect_revert("[EXPECTED] this operator already has an agent"):
            contract.register_agent(
                "second", "Second Agent", hx(direct_alice), "quote", MANIFEST_URL
            )
    agent = contract.get_agent("helios")
    assert agent["bond_atto"] == 10 * GEN
    assert agent["status"] == "ACTIVE"
    assert agent["reputation"] == 500


def test_attestation_binds_wallet_and_manifest(direct_vm, direct_deploy, direct_alice):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    agent = contract.get_agent("helios")
    assert agent["verified"] is True
    assert agent["wallet_listed"] is True
    assert agent["name_listed"] is True
    assert agent["data_policy_present"] is True
    assert agent["security_contact_present"] is True
    assert agent["autonomy_level"] == "AUTONOMOUS"
    assert agent["reputation"] == 500 + 40 + 20 + 20


def test_re_attestation_does_not_farm_reputation(direct_vm, direct_deploy, direct_alice):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    before = contract.get_agent("helios")["reputation"]
    contract.attest_agent("helios")
    assert contract.get_agent("helios")["reputation"] == before


def test_attestation_disagrees_when_validator_sees_another_manifest(direct_vm, direct_deploy, direct_alice):
    contract = deploy(direct_deploy)
    mock_sources(direct_vm, hx(direct_alice))
    register(direct_vm, contract, direct_alice, hx(direct_alice))
    contract.attest_agent("helios")
    assert direct_vm.run_validator() is True

    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r"agents\.example/helios",
        {"status": 200, "body": manifest_for("Helios Trader", "0x" + "11" * 20)},
    )
    direct_vm.mock_llm(
        r"You are the identity verifier",
        json.dumps(dict(ATTEST_OK, is_manifest=False)),
    )
    assert direct_vm.run_validator() is False


# ---------------------------------------------------------------------------
# Underwriting and cover
# ---------------------------------------------------------------------------
def test_quote_prices_the_declared_perils(direct_vm, direct_deploy, direct_alice):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    with as_user(direct_vm, direct_alice):
        quote_id = contract.request_quote(
            "helios", 1_000 * GEN, 50 * GEN, 30, "MISBEHAVIOR,DATA_LEAK", "customer PII: names, emails"
        )
    quote = contract.get_quote(quote_id)
    assert quote["decision"] == "ACCEPT"
    # Record-derived, not model prose: verified, data policy, autonomous,
    # zero policies, reputation 580, bonded above twice the minimum.
    assert quote["risk_score"] == 55
    assert quote["data_leak_risk"] == 35
    assert quote["fee_bps"] == 500
    # 180 base + 55*6 + 35*3 + 120 data-leak load.
    assert quote["rate_bps"] == 180 + 330 + 105 + 120
    expected = 1_000 * GEN * quote["rate_bps"] * 30 // (BPS * 365)
    assert quote["premium_atto"] == expected
    assert quote["expires_at"] == int(BASE.timestamp()) + 3 * 86_400
    assert "sanctioned counterparties" in quote["exclusions"]


def test_declined_quote_cannot_be_bound(direct_vm, direct_deploy, direct_alice):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), underwrite=UNDERWRITE_DECLINE)
    with as_user(direct_vm, direct_alice):
        quote_id = contract.request_quote(
            "helios", 1_000 * GEN, 0, 30, "MISBEHAVIOR", ""
        )
    assert contract.get_quote(quote_id)["decision"] == "DECLINE"
    with as_user(direct_vm, direct_alice, 1 * GEN):
        with direct_vm.expect_revert("[EXPECTED] quote was declined"):
            contract.bind_policy(quote_id)


def test_data_leak_cover_requires_a_data_scope(direct_vm, direct_deploy, direct_alice):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    with as_user(direct_vm, direct_alice):
        with direct_vm.expect_revert("[EXPECTED] data scope is required"):
            contract.request_quote("helios", 1_000 * GEN, 0, 30, "DATA_LEAK", "")


def test_bind_requires_exact_premium_and_reserves_capital(
    direct_vm, direct_deploy, direct_alice, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    with as_user(direct_vm, direct_charlie, 50_000 * GEN):
        contract.fund_pool()
    with as_user(direct_vm, direct_alice):
        quote_id = contract.request_quote(
            "helios", 1_000 * GEN, 50 * GEN, 30, "MISBEHAVIOR", ""
        )
    quote = contract.get_quote(quote_id)
    with as_user(direct_vm, direct_alice, quote["premium_atto"] - 1):
        with direct_vm.expect_revert("premium must be exactly"):
            contract.bind_policy(quote_id)
    with as_user(direct_vm, direct_alice, quote["premium_atto"]):
        policy_id = contract.bind_policy(quote_id)

    policy = contract.get_policy(policy_id)
    assert policy["status"] == "ACTIVE"
    assert policy["remaining_atto"] == 1_000 * GEN
    assert policy["holder"] == hx(direct_alice)
    assert policy["end_at"] == int(BASE.timestamp()) + 30 * 86_400

    pool = contract.get_pool()
    fee = quote["premium_atto"] * 500 // BPS
    assert pool["assets_atto"] == 50_000 * GEN + quote["premium_atto"] - fee
    assert pool["reserved_atto"] == 1_000 * GEN
    assert pool["treasury_atto"] == fee
    assert contract.get_agent("helios")["policies"] == 1


def test_lp_cannot_withdraw_reserved_capital(
    direct_vm, direct_deploy, direct_alice, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    pool = contract.get_pool()
    with as_user(direct_vm, direct_charlie):
        with direct_vm.expect_revert("capital is reserved"):
            contract.withdraw_pool(pool["total_shares"])
    free = pool["free_atto"]
    shares = free * pool["total_shares"] // pool["assets_atto"]
    with as_user(direct_vm, direct_charlie):
        contract.withdraw_pool(shares)
    after = contract.get_pool()
    assert after["reserved_atto"] == 1_000 * GEN
    assert after["free_atto"] >= 0


# ---------------------------------------------------------------------------
# Claims
# ---------------------------------------------------------------------------
def test_insured_cannot_claim_against_itself(
    direct_vm, direct_deploy, direct_alice, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    with as_user(direct_vm, direct_alice):
        with direct_vm.expect_revert("cannot claim against itself"):
            contract.file_claim(
                policy_id, "INC-1", "MISBEHAVIOR", INCIDENT, 500 * GEN, CLAIM_EVIDENCE
            )


def test_claim_is_adjudicated_and_paid_once(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)

    status = contract.adjudicate_claim(claim_id)
    assert status == "PAY_PENDING"
    claim = contract.get_claim(claim_id)
    assert claim["verdict"] == "PAY"
    assert claim["payout_ratio_bps"] == 8000
    # 500 * 8000/10000 = 400, minus the 50 GEN deductible.
    assert claim["payout_atto"] == 350 * GEN
    assert claim["appeal_deadline"] == int(BASE.timestamp()) + 3 * 86_400

    jump(direct_vm, 4)
    assert contract.settle_claim(claim_id) == "PAY_SENT"
    claim = contract.get_claim(claim_id)
    assert claim["status"] == "PAY_SENT"
    assert claim["settled"] is False
    assert contract.get_pool()["pending_payout_atto"] == 350 * GEN

    jump(direct_vm, 5)
    with as_user(direct_vm, direct_bob):
        assert contract.confirm_payout(claim["payout_id"]) == "DELIVERED"
    claim = contract.get_claim(claim_id)
    assert claim["status"] == "PAID"
    assert claim["settled"] is True
    assert contract.get_pool()["pending_payout_atto"] == 0

    pool = contract.get_pool()
    policy = contract.get_policy(policy_id)
    agent = contract.get_agent("helios")
    assert policy["remaining_atto"] == 650 * GEN
    assert policy["paid_atto"] == 350 * GEN
    assert agent["upheld_claims"] == 1
    assert agent["paid_atto"] == 350 * GEN
    assert agent["reputation"] < 500
    assert pool["reserved_atto"] == 650 * GEN

    with direct_vm.expect_revert("already settled"):
        contract.settle_claim(claim_id)


def test_duplicate_incident_reference_is_rejected(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    with as_user(direct_vm, direct_bob):
        with direct_vm.expect_revert("already has a claim"):
            contract.file_claim(
                policy_id, "INC-2031-03-02", "MISBEHAVIOR", INCIDENT, 500 * GEN, CLAIM_EVIDENCE
            )


def test_fraud_flag_denies_without_paying(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), claim=CLAIM_FRAUD)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    assert contract.adjudicate_claim(claim_id) == "DENY_PENDING"
    claim = contract.get_claim(claim_id)
    assert claim["verdict"] == "DENY"
    assert claim["fraud_suspected"] is True
    assert claim["payout_atto"] == 0
    jump(direct_vm, 4)
    assert contract.settle_claim(claim_id) == "DENY_FINAL"
    assert contract.get_policy(policy_id)["remaining_atto"] == 1_000 * GEN


def test_unreadable_evidence_stays_open_then_fails(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), evidence_status=503)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)

    assert contract.adjudicate_claim(claim_id) == "OPEN"
    claim = contract.get_claim(claim_id)
    assert claim["verdict"] == "UNDETERMINED"
    assert claim["attempts"] == 1

    contract.adjudicate_claim(claim_id)
    assert contract.adjudicate_claim(claim_id) == "DENY_FINAL"
    jump(direct_vm, 1)
    assert contract.settle_claim(claim_id) == "DENY_FINAL"


# ---------------------------------------------------------------------------
# Bonded appeal
# ---------------------------------------------------------------------------
def test_insured_appeal_can_overturn_a_payout(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    payout = contract.get_claim(claim_id)["payout_atto"]
    bond = max(payout * 2_000 // BPS, 5 * 10 ** 16)

    with as_user(direct_vm, direct_bob):
        with direct_vm.expect_revert("only the insured operator"):
            contract.appeal_claim(claim_id)
    with as_user(direct_vm, direct_alice, bond):
        contract.appeal_claim(claim_id)
    assert contract.get_claim(claim_id)["status"] == "APPEALED"

    # The appeals mock returns DENY, so this flips the verdict.
    jump(direct_vm, 1)
    assert contract.resolve_appeal(claim_id) == "DENY_FINAL"
    claim = contract.get_claim(claim_id)
    assert claim["appeal_bond_atto"] == 0
    assert claim["payout_atto"] == 0

    jump(direct_vm, 1)
    assert contract.settle_claim(claim_id) == "DENY_FINAL"
    assert contract.get_policy(policy_id)["remaining_atto"] == 1_000 * GEN
    assert contract.get_agent("helios")["upheld_claims"] == 0


def test_losing_appeal_bond_stays_with_the_pool(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), appeal=CLAIM_PAY)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    payout = contract.get_claim(claim_id)["payout_atto"]
    bond = max(payout * 2_000 // BPS, 5 * 10 ** 16)
    assets_before = contract.get_pool()["assets_atto"]

    with as_user(direct_vm, direct_alice, bond):
        contract.appeal_claim(claim_id)
    assert contract.resolve_appeal(claim_id) == "PAY_FINAL"
    assert contract.get_pool()["assets_atto"] == assets_before + bond
    assert contract.get_claim(claim_id)["appeal_bond_atto"] == 0

    jump(direct_vm, 1)
    assert contract.settle_claim(claim_id) == "PAY_SENT"
    jump(direct_vm, 2)
    with as_user(direct_vm, direct_bob):
        assert contract.confirm_payout(contract.get_claim(claim_id)["payout_id"]) == "DELIVERED"


def test_denied_claimant_can_appeal_a_denial(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), claim=CLAIM_FRAUD)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)

    with as_user(direct_vm, direct_alice, 5 * 10 ** 16):
        with direct_vm.expect_revert("only the claimant may appeal"):
            contract.appeal_claim(claim_id)
    with as_user(direct_vm, direct_bob, 5 * 10 ** 16):
        contract.appeal_claim(claim_id)
    assert contract.get_claim(claim_id)["status"] == "APPEALED"


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------
def test_stats_track_the_lifecycle(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    jump(direct_vm, 4)
    contract.settle_claim(claim_id)
    jump(direct_vm, 5)
    with as_user(direct_vm, direct_bob):
        contract.confirm_payout(contract.get_claim(claim_id)["payout_id"])
    stats = contract.get_stats()
    assert stats["agents_registered"] == 1
    assert stats["attestations"] == 1
    assert stats["quotes"] == 1
    assert stats["policies_bound"] == 1
    assert stats["premium_atto_total"] == contract.get_policy(policy_id)["premium_atto"]
    assert stats["claims_filed"] == 1
    assert stats["claims_paid"] == 1
    assert stats["paid_atto_total"] == 350 * GEN
    assert stats["agents_total"] == 1
    assert stats["policies_total"] == 1
    assert stats["claims_total"] == 1


# ---------------------------------------------------------------------------
# Validator agreement and disagreement
# ---------------------------------------------------------------------------
def test_underwriting_validator_ignores_advisory_model_scores(
    direct_vm, direct_deploy, direct_alice
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    with as_user(direct_vm, direct_alice):
        contract.request_quote("helios", 1_000 * GEN, 0, 30, "MISBEHAVIOR", "")

    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), underwrite=dict(UNDERWRITE_ACCEPT, risk_score=44, data_leak_risk=35))
    # The premium is derived from the on-chain record, so a model score change
    # cannot move the money and does not split validators.
    assert direct_vm.run_validator() is True

    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), underwrite=dict(UNDERWRITE_ACCEPT, risk_score=95, data_leak_risk=95))
    assert direct_vm.run_validator() is True


def test_underwriting_validator_rejects_another_decision(
    direct_vm, direct_deploy, direct_alice
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    with as_user(direct_vm, direct_alice):
        contract.request_quote("helios", 1_000 * GEN, 0, 30, "MISBEHAVIOR", "")

    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), underwrite=UNDERWRITE_DECLINE)
    assert direct_vm.run_validator() is False


def test_claim_validator_tolerates_quantum_noise(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)

    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), claim=dict(CLAIM_PAY, payout_ratio_bps=8200))
    # 8200 snaps to 8000: the payout is identical.
    assert direct_vm.run_validator() is True

    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), claim=dict(CLAIM_PAY, payout_ratio_bps=9500))
    # 9500 snaps to 9500, a different 5% band.
    assert direct_vm.run_validator() is False

    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice), claim=dict(CLAIM_PAY, payout_ratio_bps=5000))
    assert direct_vm.run_validator() is False


def test_claim_validator_rejects_a_flipped_verdict(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)

    direct_vm.clear_mocks()
    mock_sources(
        direct_vm,
        hx(direct_alice),
        claim=dict(CLAIM_PAY, verdict="DENY", payout_ratio_bps=0, covered_peril="NONE"),
    )
    assert direct_vm.run_validator() is False


def test_underwriting_flags_force_an_exclusion(direct_vm, direct_deploy, direct_alice):
    contract = deploy(direct_deploy)
    mock_sources(
        direct_vm,
        hx(direct_alice),
        data_policy=False,
        attest=dict(ATTEST_OK, data_policy_present=False),
    )
    register(direct_vm, contract, direct_alice, hx(direct_alice))
    contract.attest_agent("helios")
    with as_user(direct_vm, direct_alice):
        quote_id = contract.request_quote(
            "helios", 1_000 * GEN, 0, 30, "MISBEHAVIOR", ""
        )
    quote = contract.get_quote(quote_id)
    assert quote["decision"] == "ACCEPT"
    assert "NO_DATA_POLICY" in quote["flags"]
    # The flag-derived exclusion is appended even though the model prose differs.
    assert "data-leak claims" in quote["exclusions"]
    assert "sanctioned counterparties" in quote["exclusions"]


def test_no_data_policy_flag_declines_leak_cover(direct_vm, direct_deploy, direct_alice):
    contract = deploy(direct_deploy)
    mock_sources(
        direct_vm,
        hx(direct_alice),
        data_policy=False,
        attest=dict(ATTEST_OK, data_policy_present=False),
    )
    register(direct_vm, contract, direct_alice, hx(direct_alice))
    contract.attest_agent("helios")
    with as_user(direct_vm, direct_alice):
        quote_id = contract.request_quote(
            "helios", 1_000 * GEN, 0, 30, "DATA_LEAK", "customer emails"
        )
    quote = contract.get_quote(quote_id)
    assert quote["decision"] == "DECLINE"
    assert "NO_DATA_POLICY" in quote["flags"]
    assert quote["premium_atto"] == 0


def test_underwriting_validator_ignores_model_flag_drift(
    direct_vm, direct_deploy, direct_alice
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    with as_user(direct_vm, direct_alice):
        contract.request_quote("helios", 1_000 * GEN, 0, 30, "MISBEHAVIOR", "")

    direct_vm.clear_mocks()
    mock_sources(
        direct_vm,
        hx(direct_alice),
        underwrite=dict(UNDERWRITE_ACCEPT, flags=["THIN_RECORD"]),
    )
    # Flags are derived from the attestation record, not the model's list.
    assert direct_vm.run_validator() is True


def test_quote_prices_from_the_on_chain_record(direct_vm, direct_deploy, direct_alice):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(
        direct_vm,
        hx(direct_alice),
        underwrite=dict(UNDERWRITE_ACCEPT, risk_score=10, data_leak_risk=95),
    )
    with as_user(direct_vm, direct_alice):
        quote_id = contract.request_quote(
            "helios", 1_000 * GEN, 0, 30, "MISBEHAVIOR,DATA_LEAK", "customer PII"
        )
    quote = contract.get_quote(quote_id)
    # The model's advisory scores are ignored for pricing and stored scores.
    assert quote["risk_score"] == 55
    assert quote["data_leak_risk"] == 35
    assert quote["rate_bps"] == 180 + 55 * 6 + 35 * 3 + 120


def test_cited_sources_are_restricted_to_fetched_urls(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(
        direct_vm,
        hx(direct_alice),
        claim=dict(CLAIM_PAY, cited_sources=[CLAIM_URL, "https://attacker.example/fake"]),
    )
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    claim = contract.get_claim(claim_id)
    assert claim["cited_sources"] == CLAIM_URL
    assert "fetched" in claim["evidence_status"]


def test_terms_are_snapshotted_on_quote_policy_and_claim(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    quote, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    policy = contract.get_policy(policy_id)
    assert quote["fee_bps"] == 500
    assert policy["fee_atto"] == quote["premium_atto"] * 500 // BPS
    assert policy["report_window"] == 30 * 86_400

    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    contract.set_terms(
        900,
        5 * GEN,
        0,
        1,
        100_000 * GEN,
        1,
        1,
        3 * 86_400,
        86_400,
        86_400,
        5 * 10 ** 16,
    )
    assert contract.get_quote(quote["quote_id"])["fee_bps"] == 500
    assert contract.get_policy(policy_id)["fee_atto"] == quote["premium_atto"] * 500 // BPS
    assert contract.get_policy(policy_id)["report_window"] == 30 * 86_400
    claim = contract.get_claim(claim_id)
    assert claim["appeal_window"] == 3 * 86_400

    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    claim = contract.get_claim(claim_id)
    assert claim["appeal_deadline"] == claim["adjudicated_at"] + 3 * 86_400


def test_claim_review_waits_for_the_insured_response(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(
        direct_vm,
        hx(direct_alice),
        claim=dict(CLAIM_PAY, cited_sources=[CLAIM_URL]),
    )
    direct_vm.mock_web(
        r"defence\.example/log",
        {"status": 200, "body": "Operator approval log: transfer authorised at 10:02 UTC."},
    )
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)

    with direct_vm.expect_revert("insured response window is still open"):
        contract.adjudicate_claim(claim_id)
    with as_user(direct_vm, direct_bob):
        with direct_vm.expect_revert("only the insured operator"):
            contract.respond_to_claim(claim_id, "not my claim to answer at all", CLAIM_URL)
    with as_user(direct_vm, direct_alice):
        contract.respond_to_claim(
            claim_id,
            "The transfer was authorised by the operator and is outside the alleged loss.",
            "https://defence.example/log",
        )

    claim = contract.get_claim(claim_id)
    assert claim["defense_status"] == "FILED"
    assert "defence.example" in claim["defense_evidence"]
    assert contract.adjudicate_claim(claim_id) == "PAY_PENDING"
    claim = contract.get_claim(claim_id)
    assert claim["cited_sources"] == CLAIM_URL
    assert "defence.example" in claim["evidence_status"]


def test_payout_is_an_obligation_until_the_recipient_confirms(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    jump(direct_vm, 4)
    assert contract.settle_claim(claim_id) == "PAY_SENT"

    claim = contract.get_claim(claim_id)
    payout = contract.get_payout(claim["payout_id"])
    assert payout["status"] == "SENT"
    assert payout["amount_atto"] == 350 * GEN
    assert contract.get_pool()["pending_payout_atto"] == 350 * GEN
    assert claim["settled"] is False

    with as_user(direct_vm, direct_alice):
        with direct_vm.expect_revert("only the recipient"):
            contract.confirm_payout(claim["payout_id"])
    with as_user(direct_vm, direct_bob):
        assert contract.confirm_payout(claim["payout_id"]) == "DELIVERED"
    assert contract.get_pool()["pending_payout_atto"] == 0
    assert contract.get_claim(claim_id)["status"] == "PAID"


def test_failed_payout_can_be_recovered_without_double_paying(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    jump(direct_vm, 4)
    contract.settle_claim(claim_id)
    payout_id = contract.get_claim(claim_id)["payout_id"]

    with as_user(direct_vm, direct_bob, 350 * GEN):
        contract.__on_errored_message__()
    payout = contract.get_payout(payout_id)
    assert payout["status"] == "FAILED"
    assert contract.get_claim(claim_id)["status"] == "PAY_SENT"
    assert contract.get_pool()["pending_payout_atto"] == 350 * GEN

    contract.retry_payout(payout_id)
    assert contract.get_payout(payout_id)["attempts"] == 2
    with as_user(direct_vm, direct_bob):
        assert contract.confirm_payout(payout_id) == "DELIVERED"
    assert contract.get_pool()["pending_payout_atto"] == 0
    assert contract.get_claim(claim_id)["status"] == "PAID"
    with direct_vm.expect_revert("already settled"):
        contract.settle_claim(claim_id)


def test_appeal_timeout_frees_the_claim_and_forfeits_the_bond(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    payout = contract.get_claim(claim_id)["payout_atto"]
    bond = max(payout * 2_000 // BPS, 5 * 10 ** 16)
    assets_before = contract.get_pool()["assets_atto"]

    with as_user(direct_vm, direct_alice, bond):
        contract.appeal_claim(claim_id)
    jump(direct_vm, 8)
    with direct_vm.expect_revert("appeal expired"):
        contract.resolve_appeal(claim_id)
    assert contract.expire_appeal(claim_id) == "PAY_PENDING"
    assert contract.get_claim(claim_id)["appeal_bond_atto"] == 0
    assert contract.get_pool()["assets_atto"] == assets_before + bond

    assert contract.settle_claim(claim_id) == "PAY_SENT"
    with as_user(direct_vm, direct_bob):
        contract.confirm_payout(contract.get_claim(claim_id)["payout_id"])
    assert contract.get_claim(claim_id)["status"] == "PAID"


def test_lp_withdrawal_is_ledgered_until_confirmed(
    direct_vm, direct_deploy, direct_alice, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    with as_user(direct_vm, direct_charlie, 50_000 * GEN):
        contract.fund_pool()
    with as_user(direct_vm, direct_charlie):
        contract.withdraw_pool(1_000 * GEN)

    payouts = contract.list_payouts(0, 10)
    payout = contract.get_payout(payouts[-1])
    assert payout["kind"] == "LP"
    assert payout["amount_atto"] == 1_000 * GEN
    assert payout["status"] == "SENT"
    assert contract.get_pool()["assets_atto"] == 49_000 * GEN
    assert contract.get_pool()["pending_payout_atto"] == 1_000 * GEN

    with as_user(direct_vm, direct_alice):
        with direct_vm.expect_revert("only the recipient"):
            contract.confirm_payout(payout["payout_id"])
    with as_user(direct_vm, direct_charlie):
        assert contract.confirm_payout(payout["payout_id"]) == "DELIVERED"
    assert contract.get_pool()["pending_payout_atto"] == 0


def test_bond_is_locked_while_cover_is_live(
    direct_vm, direct_deploy, direct_alice, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    with as_user(direct_vm, direct_alice):
        with direct_vm.expect_revert("bond is locked"):
            contract.withdraw_bond("helios", 1 * GEN)
        with direct_vm.expect_revert("active policies or open claims"):
            contract.set_agent_status("helios", "RETIRED")


def test_a_late_return_reopens_a_confirmed_payout(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    jump(direct_vm, 4)
    contract.settle_claim(claim_id)
    payout_id = contract.get_claim(claim_id)["payout_id"]
    jump(direct_vm, 5)
    with as_user(direct_vm, direct_bob):
        contract.confirm_payout(payout_id)
    assert contract.get_claim(claim_id)["status"] == "PAID"
    assert contract.get_agent("helios")["claims"] == 1

    # A return that arrives after confirmation must reopen the obligation,
    # not leave the claim marked paid with the money back in the contract.
    with as_user(direct_vm, direct_bob, 350 * GEN):
        contract.__on_errored_message__()
    claim = contract.get_claim(claim_id)
    assert claim["status"] == "PAY_FINAL"
    assert claim["settled"] is False
    assert claim["payout_status"] == "FAILED"
    assert contract.get_payout(payout_id)["status"] == "FAILED"
    assert contract.get_pool()["pending_payout_atto"] == 350 * GEN
    assert contract.get_policy(policy_id)["open_claims"] == 1
    assert contract.get_agent("helios")["claims"] == 0

    contract.retry_payout(payout_id)
    with as_user(direct_vm, direct_bob):
        assert contract.confirm_payout(payout_id) == "DELIVERED"
    assert contract.get_claim(claim_id)["status"] == "PAID"
    assert contract.get_pool()["pending_payout_atto"] == 0
    assert contract.get_agent("helios")["claims"] == 1


# ---------------------------------------------------------------------------
# P1: corroboration, bond waterfall, evidence retention and conservation
# ---------------------------------------------------------------------------
def test_terms_require_two_evidence_urls(direct_deploy):
    contract = deploy(direct_deploy)
    assert contract.get_terms()["min_evidence_urls"] == 2


def test_high_value_payout_needs_two_independent_hosts(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice))
    direct_vm.mock_web(
        r"evidence\.example/second",
        {"status": 200, "body": "A second page on the same host repeats the claim."},
    )
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    with as_user(direct_vm, direct_bob):
        claim_id = contract.file_claim(
            policy_id,
            "INC-SAME-HOST",
            "MISBEHAVIOR",
            INCIDENT,
            500 * GEN,
            CLAIM_URL + "\nhttps://evidence.example/second",
        )
    waive(direct_vm, contract, direct_alice, claim_id)
    assert contract.adjudicate_claim(claim_id) == "DENY_PENDING"
    claim = contract.get_claim(claim_id)
    assert claim["verdict"] == "DENY"
    assert claim["payout_atto"] == 0
    assert claim["corroboration_required"] is True
    assert claim["corroboration_met"] is False
    assert claim["corroboration_domains"] == "evidence.example"
    assert "independent corroboration" in claim["rationale"]


def test_small_payout_can_rest_on_one_host(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    direct_vm.clear_mocks()
    mock_sources(direct_vm, hx(direct_alice))
    direct_vm.mock_web(
        r"evidence\.example/second",
        {"status": 200, "body": "A second page on the same host repeats the claim."},
    )
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    with as_user(direct_vm, direct_bob):
        claim_id = contract.file_claim(
            policy_id,
            "INC-SMALL",
            "MISBEHAVIOR",
            INCIDENT,
            100 * GEN,
            CLAIM_URL + "\nhttps://evidence.example/second",
        )
    waive(direct_vm, contract, direct_alice, claim_id)
    assert contract.adjudicate_claim(claim_id) == "PAY_PENDING"
    claim = contract.get_claim(claim_id)
    assert claim["verdict"] == "PAY"
    assert claim["payout_atto"] == 30 * GEN
    assert claim["corroboration_required"] is False
    assert claim["corroboration_met"] is False


def test_claim_needs_the_configured_number_of_evidence_urls(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    with as_user(direct_vm, direct_bob):
        with direct_vm.expect_revert("not enough evidence URLs"):
            contract.file_claim(
                policy_id,
                "INC-ONE-URL",
                "MISBEHAVIOR",
                INCIDENT,
                500 * GEN,
                CLAIM_URL,
            )


def test_bond_absorbs_the_first_loss_and_suspends_a_thin_agent(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    agent_before = contract.get_agent("helios")
    assert agent_before["bond_atto"] == 10 * GEN
    assets_before = contract.get_pool()["assets_atto"]

    jump(direct_vm, 4)
    assert contract.settle_claim(claim_id) == "PAY_SENT"
    claim = contract.get_claim(claim_id)
    agent = contract.get_agent("helios")
    assert claim["bond_slashed_atto"] == 10 * GEN
    assert agent["bond_atto"] == 0
    assert agent["bond_slashed_atto"] == 10 * GEN
    assert agent["status"] == "SUSPENDED"
    assert contract.get_pool()["assets_atto"] == assets_before - 350 * GEN + 10 * GEN
    assert contract.get_stats()["bond_slashed_atto"] == 10 * GEN

    with as_user(direct_vm, direct_alice):
        with direct_vm.expect_revert("agent is not active"):
            contract.withdraw_bond("helios", 1 * GEN)
        with direct_vm.expect_revert("bond below the minimum"):
            contract.set_agent_status("helios", "ACTIVE")
    with as_user(direct_vm, direct_alice, 5 * GEN):
        contract.add_bond("helios")
    with as_user(direct_vm, direct_alice):
        contract.set_agent_status("helios", "ACTIVE")
    assert contract.get_agent("helios")["status"] == "ACTIVE"


def test_full_sha256_fingerprint_is_retained_per_source(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    claim = contract.get_claim(claim_id)
    rows = claim["evidence_digests"].split("; ")
    assert len(rows) == 2
    for row in rows:
        index, digest = row.split(":", 1)
        assert index in ("1", "2")
        assert len(digest) == 64
        int(digest, 16)
    assert "fetched" in claim["evidence_status"]


def test_pool_accounting_conserves_value_across_a_confirmed_claim(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    quote, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    jump(direct_vm, 4)
    contract.settle_claim(claim_id)
    claim = contract.get_claim(claim_id)
    with as_user(direct_vm, direct_bob):
        assert contract.confirm_payout(claim["payout_id"]) == "DELIVERED"

    pool = contract.get_pool()
    claim = contract.get_claim(claim_id)
    assert claim["status"] == "PAID"
    # Pool assets + fee treasury + money in flight + confirmed claim payouts
    # equals LP deposits + premiums + bond collateral that was slashed in.
    assert (
        pool["assets_atto"]
        + pool["treasury_atto"]
        + pool["pending_payout_atto"]
        + claim["payout_atto"]
        == 50_000 * GEN + quote["premium_atto"] + claim["bond_slashed_atto"]
    )
    assert pool["free_atto"] == pool["assets_atto"] - pool["reserved_atto"]
    assert pool["assets_atto"] >= pool["reserved_atto"]


def test_appeal_cannot_restore_a_high_value_payout_from_one_host(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = attested_agent(direct_vm, direct_deploy, direct_alice)
    _, policy_id = fund_and_bind(direct_vm, contract, direct_alice, direct_charlie)
    claim_id = file_claim_as_bob(direct_vm, contract, direct_bob, policy_id)
    waive(direct_vm, contract, direct_alice, claim_id)
    contract.adjudicate_claim(claim_id)
    payout = contract.get_claim(claim_id)["payout_atto"]
    bond = max(payout * 2_000 // BPS, 5 * 10 ** 16)
    with as_user(direct_vm, direct_alice, bond):
        contract.appeal_claim(claim_id)

    # The second host becomes unreadable while the appeal is pending; the
    # appeals panel still says PAY, but the deterministic corroboration rule
    # must refuse to restore a high-value payout from a single host.
    direct_vm.clear_mocks()
    mock_sources(
        direct_vm,
        hx(direct_alice),
        appeal=dict(CLAIM_PAY),
        corroboration_status=503,
    )
    jump(direct_vm, 1)
    assert contract.resolve_appeal(claim_id) == "DENY_FINAL"
    claim = contract.get_claim(claim_id)
    assert claim["verdict"] == "DENY"
    assert claim["corroboration_required"] is True
    assert claim["corroboration_met"] is False
    assert claim["corroboration_domains"] == "evidence.example"
    assert claim["appeal_bond_atto"] == 0
    refunds = [
        contract.get_payout(payout_id)
        for payout_id in contract.list_payouts(0, 20)
    ]
    assert any(
        row["kind"] == "BOND_REFUND" and row["ref"] == claim_id and row["amount_atto"] == bond
        for row in refunds
    )
