;; claims-processor.clar
;; Core smart contract for processing insurance claims for aid workers.
;; This contract automates claim evaluation based on policy terms, incident reports,
;; and oracle verifications. It triggers payouts if conditions are met and handles
;; basic dispute initiation.

;; Constants
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-CLAIM u101)
(define-constant ERR-POLICY-INACTIVE u102)
(define-constant ERR-INCIDENT-NOT-VERIFIED u103)
(define-constant ERR-INSUFFICIENT-FUNDS u104)
(define-constant ERR-CLAIM-ALREADY-PROCESSED u105)
(define-constant ERR-DISPUTE-IN-PROGRESS u106)
(define-constant ERR-INVALID-AMOUNT u107)
(define-constant ERR-CLAIM-EXPIRED u108)
(define-constant ERR-ORACLE-NOT-CONFIRMED u109)
(define-constant ERR-INVALID-PARAMS u110)
(define-constant ERR-CONTRACT-PAUSED u111)

(define-constant CLAIM-STATUS-PENDING u0)
(define-constant CLAIM-STATUS-APPROVED u1)
(define-constant CLAIM-STATUS-REJECTED u2)
(define-constant CLAIM-STATUS-DISPUTED u3)

(define-constant MAX-CLAIM-AMOUNT u1000000000) ;; 1 billion micro-STX
(define-constant CLAIM-WINDOW-BLOCKS u144) ;; ~1 day in Stacks blocks
(define-constant DISPUTE_WINDOW-BLOCKS u720) ;; ~5 days

;; Traits for inter-contract interactions
;; Assuming traits are defined in separate files
(define-trait user-registry-trait
  (
    (is-registered (principal) (response bool uint))
    (get-user-role (principal) (response (string-ascii 32) uint))
  )
)

(define-trait policy-manager-trait
  (
    (get-policy (uint) (response {active: bool, coverage-amount: uint, terms-hash: (buff 32), insured: principal} uint))
    (mark-claim-processed (uint uint) (response bool uint))
  )
)

(define-trait incident-reporter-trait
  (
    (get-incident (uint) (response {verified: bool, timestamp: uint, severity: uint, reporter: principal} uint))
  )
)

(define-trait oracle-verifier-trait
  (
    (confirm-incident (uint (buff 32)) (response bool uint))
  )
)

(define-trait payout-distributor-trait
  (
    (distribute-payout (principal uint (string-utf8 256)) (response bool uint))
  )
)

(define-trait premium-vault-trait
  (
    (get-available-funds () (response uint uint))
    (lock-funds (uint) (response bool uint))
    (release-funds (uint) (response bool uint))
  )
)

(define-trait dispute-resolver-trait
  (
    (initiate-dispute (uint principal (string-utf8 500)) (response uint uint))
  )
)

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var claim-counter uint u0)

;; Data Maps
(define-map claims
  { claim-id: uint }
  {
    policy-id: uint,
    incident-id: uint,
    claimant: principal,
    amount: uint,
    status: uint,
    submit-block: uint,
    process-block: (optional uint),
    evidence-hash: (buff 32),
    description: (string-utf8 500)
  }
)

(define-map claim-disputes
  { claim-id: uint }
  {
    dispute-id: (optional uint),
    initiator: principal,
    reason: (string-utf8 500),
    resolved: bool
  }
)

;; Private Functions
(define-private (is-owner (caller principal))
  (is-eq caller (var-get contract-owner))
)

(define-private (increment-claim-counter)
  (let ((current (var-get claim-counter)))
    (var-set claim-counter (+ current u1))
    (+ current u1)
  )
)

(define-private (validate-claim-submission (policy-id uint) (incident-id uint) (amount uint) (evidence-hash (buff 32)) (description (string-utf8 500)))
  (and
    (> amount u0)
    (<= amount MAX-CLAIM-AMOUNT)
    (is-some (contract-call? .policy-manager get-policy policy-id))
    (let ((policy (unwrap! (contract-call? .policy-manager get-policy policy-id) (err ERR-INVALID-PARAMS))))
      (and (get active policy) (is-eq (get insured policy) tx-sender)))
    (is-some (contract-call? .incident-reporter get-incident incident-id))
  )
)

;; Public Functions
(define-public (submit-claim (policy-id uint) (incident-id uint) (amount uint) (evidence-hash (buff 32)) (description (string-utf8 500)))
  (let
    (
      (claim-id (increment-claim-counter))
    )
    (if (var-get paused)
      (err ERR-CONTRACT-PAUSED)
      (if (validate-claim-submission policy-id incident-id amount evidence-hash description)
        (begin
          (map-set claims
            { claim-id: claim-id }
            {
              policy-id: policy-id,
              incident-id: incident-id,
              claimant: tx-sender,
              amount: amount,
              status: CLAIM-STATUS-PENDING,
              submit-block: block-height,
              process-block: none,
              evidence-hash: evidence-hash,
              description: description
            }
          )
          (ok claim-id)
        )
        (err ERR-INVALID-CLAIM)
      )
    )
  )
)

(define-public (process-claim (claim-id uint))
  (let
    (
      (claim (unwrap! (map-get? claims { claim-id: claim-id }) (err ERR-INVALID-CLAIM)))
      (policy (unwrap! (contract-call? .policy-manager get-policy (get policy-id claim)) (err ERR-POLICY-INACTIVE)))
      (incident (unwrap! (contract-call? .incident-reporter get-incident (get incident-id claim)) (err ERR-INCIDENT-NOT-VERIFIED)))
      (oracle-confirmed (unwrap! (contract-call? .oracle-verifier confirm-incident (get incident-id claim) (get evidence-hash claim)) (err ERR-ORACLE-NOT-CONFIRMED)))
    )
    (if (var-get paused)
      (err ERR-CONTRACT-PAUSED)
      (if (or (not (is-eq (get status claim) CLAIM-STATUS-PENDING)) (is-some (get process-block claim)))
        (err ERR-CLAIM-ALREADY-PROCESSED)
        (if (> (- block-height (get submit-block claim)) CLAIM-WINDOW-BLOCKS)
          (err ERR-CLAIM-EXPIRED)
          (if (and (get verified incident) oracle-confirmed (get active policy) (<= (get amount claim) (get coverage-amount policy)))
            (match (contract-call? .premium-vault lock-funds (get amount claim))
              success (begin
                (match (contract-call? .payout-distributor distribute-payout (get claimant claim) (get amount claim) (get description claim))
                  payout-success (begin
                    (map-set claims { claim-id: claim-id } (merge claim { status: CLAIM-STATUS-APPROVED, process-block: (some block-height) }))
                    (try! (contract-call? .policy-manager mark-claim-processed (get policy-id claim) claim-id))
                    (ok CLAIM-STATUS-APPROVED)
                  )
                  payout-error (begin
                    (try! (contract-call? .premium-vault release-funds (get amount claim)))
                    (err payout-error)
                  )
                )
              )
              error (err ERR-INSUFFICIENT-FUNDS)
            )
            (begin
              (map-set claims { claim-id: claim-id } (merge claim { status: CLAIM-STATUS-REJECTED, process-block: (some block-height) }))
              (ok CLAIM-STATUS-REJECTED)
            )
          )
        )
      )
    )
  )
)

(define-public (initiate-dispute (claim-id uint) (reason (string-utf8 500)))
  (let
    (
      (claim (unwrap! (map-get? claims { claim-id: claim-id }) (err ERR-INVALID-CLAIM)))
      (dispute-opt (map-get? claim-disputes { claim-id: claim-id }))
    )
    (if (var-get paused)
      (err ERR-CONTRACT-PAUSED)
      (if (or (is-eq (get status claim) CLAIM-STATUS-PENDING) (get resolved (default-to { resolved: false } dispute-opt)))
        (err ERR-DISPUTE-IN-PROGRESS)
        (if (> (- block-height (unwrap! (get process-block claim) (err ERR-CLAIM-ALREADY-PROCESSED))) DISPUTE_WINDOW-BLOCKS)
          (err ERR-CLAIM-EXPIRED)
          (match (contract-call? .dispute-resolver initiate-dispute claim-id tx-sender reason)
            dispute-id (begin
              (map-set claim-disputes { claim-id: claim-id } { dispute-id: (some dispute-id), initiator: tx-sender, reason: reason, resolved: false })
              (map-set claims { claim-id: claim-id } (merge claim { status: CLAIM-STATUS-DISPUTED }))
              (ok dispute-id)
            )
            error (err error)
          )
        )
      )
    )
  )
)

(define-public (pause-contract)
  (if (is-owner tx-sender)
    (begin
      (var-set paused true)
      (ok true)
    )
    (err ERR-NOT-AUTHORIZED)
  )
)

(define-public (unpause-contract)
  (if (is-owner tx-sender)
    (begin
      (var-set paused false)
      (ok true)
    )
    (err ERR-NOT-AUTHORIZED)
  )
)

(define-public (set-owner (new-owner principal))
  (if (is-owner tx-sender)
    (begin
      (var-set contract-owner new-owner)
      (ok true)
    )
    (err ERR-NOT-AUTHORIZED)
  )
)

;; Read-Only Functions
(define-read-only (get-claim-details (claim-id uint))
  (map-get? claims { claim-id: claim-id })
)

(define-read-only (get-claim-status (claim-id uint))
  (match (map-get? claims { claim-id: claim-id })
    claim (ok (get status claim))
    (err ERR-INVALID-CLAIM)
  )
)

(define-read-only (get-dispute-details (claim-id uint))
  (map-get? claim-disputes { claim-id: claim-id })
)

(define-read-only (is-contract-paused)
  (var-get paused)
)

(define-read-only (get-contract-owner)
  (var-get contract-owner)
)

(define-read-only (get-claim-counter)
  (var-get claim-counter)
)