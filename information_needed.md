# Information needed — Vouchsafe blocked flows

## 1. Steward request (verbatim)

> Please correct both blocked flows: pass an integer day count to request_quote in frontend/src/Desk.tsx, and make add_bond accept the positive value its body requires through the declared public dispatcher. Provide the corrected repository source with regression checks showing a normal 30-day quote can be created and bound, and an owner can top up a bond through public dispatch rather than a direct method call.

The two flows were independent failures. A third, platform-level failure appeared when the corrected contract was exercised on the current Studionet: the frontend's pinned GenLayer SDK could not send the consensus fee that Studio now requires. All three are addressed below.

## 2. Root causes

### 2.1 Frontend sent atto instead of days

`frontend/src/Desk.tsx` parsed the term with `parseGen(term)`, which converts `"30"` to `30 * 10^18` atto. The contract declares `term_days: u256` and accepts only `1..365`, so a normal 30-day quote reverted with `term must be 1-365 days`. Parsing the term as an amount also made the premium formula (`coverage × rate × term_days / 365`) wrong by 18 orders of magnitude.

**Fix:** added a strict `parseDays()` helper (`frontend/src/format.ts`) that accepts only a whole decimal day count, safe-integer checked. `Desk.tsx` now validates `1..365`, renders an inline error, and passes the integer `days` value to `request_quote`.

### 2.2 add_bond was declared non-payable while its body credits value

The body credits `gl.message.value` into `agent.bond_atto`, but the method was decorated `@gl.public.write`. The generated public ABI therefore exposed `payable: false`, and GenVM's public dispatcher rejected any value-bearing transaction before the body ran. Direct-mode tests called the method object directly, bypassing the dispatcher, so the gap was invisible to the old tests.

**Fix:** decorated `add_bond` as `@gl.public.write.payable`. The body still requires a positive value and the agent owner. The public ABI now reports `payable: true`.

### 2.3 Current Studio requires an explicit consensus fee

After the contract fixes, live writes from the frontend reverted at the consensus contract because Studio's current Consensus v0.6 requires a non-zero fee distribution and fee value. `genlayer-js` 1.1.8 has no fee envelope, and the CLI's `write` hardcodes `value: 0n` (it cannot fund a pool, post a bond, or pay a premium).

**Fix:** upgraded `frontend/package.json` to `genlayer-js` 2.2.0 and added a per-write estimate in `frontend/src/api.ts` using `estimateTransactionFeesForWrite` from a public client with the connected sender's account. The exact `fees` envelope is then passed to the wallet's `writeContract`. The live value-bearing calls in this report used the same SDK and estimator.

## 3. Corrected source

| File | Change |
|---|---|
| `frontend/src/format.ts` | new `parseDays(input): number`; rejects decimals, signs, exponents, and unsafe integers |
| `frontend/src/Desk.tsx` | validates term 1–365, passes integer `days`, renders `termError` |
| `frontend/src/styles.css` | `.form-note.form-error` styling |
| `contracts/vouchsafe.py` | `add_bond` is now `@gl.public.write.payable` |
| `tests/test_vouchsafe.py` | `public_dispatch()` resolves the generated schema, enforces the payable flag, then invokes through the public entrypoint; three regressions added |
| `frontend/src/api.ts` | estimates Studio's fee envelope before every write |
| `frontend/package.json` | `genlayer-js` 1.1.8 → 2.2.0 |
| `README.md`, `frontend/.env.*` | current contract address, deploy tx, live proof, fee instructions |

Key source now reads:

```python
# The body credits gl.message.value, so the method must be declared
# payable or the public dispatcher rejects any transaction that sends GEN.
@gl.public.write.payable
def add_bond(self, agent_id: str) -> None:
    agent_key = agent_id.strip().lower()
    agent = self._require_agent(agent_key)
    if _hx(gl.message.sender_address) != agent.owner:
        raise gl.vm.UserError(ERROR_EXPECTED + " only the operator can add bond")
    if gl.message.value == 0:
        raise gl.vm.UserError(ERROR_EXPECTED + " send GEN with add_bond")
    agent.bond_atto = u256(agent.bond_atto + gl.message.value)
```

```ts
// frontend/src/Desk.tsx
const days = parseDays(term)
if (days < 1 || days > 365) {
  setTermError('Term must be a whole number of days between 1 and 365.')
  return
}
setTermError('')
const result = await run('Quote requested', 'request_quote', [
  agentId, parseGen(coverage), parseGen(deductible), days,
  perils.join(','), dataScope,
])
```

## 4. ABI proof: old vs corrected live contract

The pre-fix contract is still readable on Studionet, so the difference is directly observable:

| Field | Old live contract `0xB110510d…` | Corrected live contract `0xA8cc6244…` |
|---|---|---|
| `add_bond` params | `[['agent_id','string']]` | same |
| `add_bond.payable` | **false** | **true** |
| `request_quote.term_days` type | `int` | `int` |
| `request_quote.payable` | false | false |

The old schema is exactly why a value-bearing `add_bond` transaction was rejected by public dispatch even though the method body could credit value in direct mode.

## 5. Regression evidence

All commands ran in `D:\Genlayer-project\vouchsafe` on Node v24.15.0 and Python 3.12.

```text
pytest tests -q
48 passed in 8.08s

pytest tests -q -k 'thirty_day or add_bond or atto_scaled'
3 passed, 45 deselected in 0.51s

genvm-lint check contracts/vouchsafe.py
✓ Lint passed (3 checks)
✓ Validation passed
  Contract: Vouchsafe
  Methods: 37 (15 view, 22 write)

cd frontend && npm run build
tsc -b && vite build
✓ built in 7.20s
```

The focused regressions are:

1. `test_thirty_day_quote_binds_when_term_is_a_day_count` — calls `request_quote(... 30 ...)` through `public_dispatch`, asserts `decision == ACCEPT`, `term_days == 30`, positive premium, then binds the quote and asserts `P1` is `ACTIVE` with `end_at == now + 30 days`.
2. `test_atto_scaled_term_is_rejected_as_a_day_count` — sends `30 * 10^18` and asserts the contract reverts with `term must be 1-365 days`.
3. `test_add_bond_tops_up_through_payable_public_dispatch` — asserts the generated schema says `add_bond.payable is True`, sends 2 GEN through `public_dispatch`, asserts the bond increases by exactly 2 GEN, and asserts zero-value and non-owner sends revert.

## 6. Live Studionet proof (correct project wallet)

All transactions below were signed by the project wallet:

```text
0x3958A649b41cd7C8561F4233cC0F5b0469Bc98E0
```

The key was read from `D:\Genlayer-project\wallet` at execution time and is not reproduced here. This is a fresh deployment of the corrected source; the old contract is not upgraded in place.

| Step | Transaction hash | On-chain result |
|---|---|---|
| Deploy | `0x75ab50a6a5f6a6c5762bac736b434729a03e709b8929136fea704f836e7f7fc9` | Finalized · Accepted; `to_address = 0xA8cc624497936E1A7845Cf1390b572773193dcCc`; constructor `500` bps, `500000000000000000` atto |
| Fund pool | `0x5e4c22f637f4d5c25cc65b79f47a33298b60a108fc63fd9ea7136254f335f692` | Finalized · Accepted; 100 GEN |
| Register agent | `0xb5f4d69bdf5df6cdf56f2b1d21c214a029f5ca056d0f08ae9ba5444bd073d0f3` | Finalized · Accepted; `vouchsafe-p1`, bond 0.5 GEN |
| **Top up bond (public dispatch)** | `0xc9cf695153458bc1d583dbbfb42e81f185fb30d85fbc8088d04068a3165bc7df` | Finalized · Accepted; `user_value = 2000000000000000000`; execution SUCCESS; bond 0.5 → 2.5 GEN |
| Attest | `0x6a2cdcf33409f35048a0baf2dadf9109a07b977250a61c08210c5401902d2e53` | Finalized · Accepted; verified, `AUTONOMOUS`, reputation 580 |
| **Create 30-day quote** | `0x1cd814e2184f39f432a56f7fa7cf6a319af33c67c0ee80842386278735dc9f27` | Finalized · Accepted; `Q1`, ACCEPT, `term_days = 30` |
| **Bind policy** | `0x1076510b8a4b28c5280c5cf811ae100bf769874bfe5c3ffaca82b38e6e9d06cc` | Finalized · Accepted; `user_value = 60410958904109589`; execution SUCCESS; payload `"P1"` |

### Quote Q1 (read back from the live contract)

```text
quote_id       Q1
requester      0x3958A649b41cd7C8561F4233cC0F5b0469Bc98E0
agent_id       vouchsafe-p1
decision       ACCEPT
term_days      30
coverage_atto  10000000000000000000      (10 GEN)
deductible_atto 500000000000000000       (0.5 GEN)
premium_atto   60410958904109589        (0.060410958904109589 GEN)
rate_bps       735
fee_bps        500
risk_score     55
confidence     65
bound          true
```

### Policy P1 and agent (read back from the live contract)

```text
policy_id      P1
status         ACTIVE
quote_id       Q1
coverage_atto  10000000000000000000
premium_atto   60410958904109589

agent_id       vouchsafe-p1
owner          0x3958A649b41cd7C8561F4233cC0F5b0469Bc98E0
bond_atto      2500000000000000000       (2.5 GEN, after the 2 GEN public top-up)
verified       true
autonomy       AUTONOMOUS
reputation     580
status         ACTIVE
```

### Fresh book

```text
pool assets    100057390410958904110    (100 GEN deposit + net premium)
pool free       90057390410958904110
pool reserved   10000000000000000000
total shares    100000000000000000000
lp_deposits     1
quotes          1
policies_bound  1
premium total   60410958904109589
claims          0
```

Read-only confirmation commands:

```bash
genlayer call 0xA8cc624497936E1A7845Cf1390b572773193dcCc get_pool
genlayer call 0xA8cc624497936E1A7845Cf1390b572773193dcCc get_agent --args vouchsafe-p1
genlayer call 0xA8cc624497936E1A7845Cf1390b572773193dcCc get_quote --args Q1
genlayer call 0xA8cc624497936E1A7845Cf1390b572773193dcCc get_policy --args P1
```

## 7. Reproduce the two originally blocked flows

### 30-day quote and bind

```ts
// term is a day count, not atto
await write(client, 'request_quote', [
  agentId, 10n * 10n ** 18n, 5n * 10n ** 17n, 30,
  'MISBEHAVIOUR,DATA_LEAK', 'customer chat transcripts and wallet identifiers',
])
// read the returned quote id, then pay its exact premium
await write(client, 'bind_policy', [quoteId], premiumAtto)
```

### Owner bond top-up through public dispatch

```ts
await write(client, 'add_bond', [agentId], 2n * 10n ** 18n)
```

The ABI for `add_bond` is now `payable: true`, so the dispatcher accepts the value. The body rejects zero value and non-owner senders.

## 8. Notes and limits

- **Authoritative address:** `0xA8cc624497936E1A7845Cf1390b572773193dcCc`. The older `0xB110510d…` deployment still exists with its old bytecode and book; it is not the corrected deployment.
- **Fees are live-platform state:** the fee value is estimated per call (observed: `377414400010352` atto for a write, `100000000000010352` atto for this deploy). These numbers are not hardcoded.
- **No claim was filed on the fresh book.** The claim/adjudication/settlement paths are covered by the 48-test direct-mode suite but were intentionally not exercised against the new live book, so the live proof stays focused on the two requested fixes.
- **Frontend build, not browser E2E:** `npm run build` passed with `genlayer-js` 2.2.0. The same fee estimator was exercised against the live contract from a public client and returned a valid envelope. A browser-wallet signature was not automated in this session.
- **Secrets:** no private key, mnemonic, or keystore material is included in this document or committed to the repository.
