import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface ClaimRecord {
  policyId: number;
  incidentId: number;
  claimant: string;
  amount: number;
  status: number;
  submitBlock: number;
  processBlock: number | null;
  evidenceHash: string; // Simplified as string for mock
  description: string;
}

interface DisputeRecord {
  disputeId: number | null;
  initiator: string;
  reason: string;
  resolved: boolean;
}

interface ContractState {
  claims: Map<number, ClaimRecord>;
  disputes: Map<number, DisputeRecord>;
  claimCounter: number;
  paused: boolean;
  owner: string;
}

// Mock contract implementation
class ClaimsProcessorMock {
  private state: ContractState = {
    claims: new Map(),
    disputes: new Map(),
    claimCounter: 0,
    paused: false,
    owner: "deployer",
  };

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_INVALID_CLAIM = 101;
  private ERR_POLICY_INACTIVE = 102;
  private ERR_INCIDENT_NOT_VERIFIED = 103;
  private ERR_INSUFFICIENT_FUNDS = 104;
  private ERR_CLAIM_ALREADY_PROCESSED = 105;
  private ERR_DISPUTE_IN_PROGRESS = 106;
  private ERR_INVALID_AMOUNT = 107;
  private ERR_CLAIM_EXPIRED = 108;
  private ERR_ORACLE_NOT_CONFIRMED = 109;
  private ERR_INVALID_PARAMS = 110;
  private ERR_CONTRACT_PAUSED = 111;

  private CLAIM_STATUS_PENDING = 0;
  private CLAIM_STATUS_APPROVED = 1;
  private CLAIM_STATUS_REJECTED = 2;
  private CLAIM_STATUS_DISPUTED = 3;

  private MAX_CLAIM_AMOUNT = 1000000000;
  private CLAIM_WINDOW_BLOCKS = 144;
  private DISPUTE_WINDOW_BLOCKS = 720;

  // Mock block height for testing
  private currentBlockHeight = 1000;

  private setBlockHeight(height: number) {
    this.currentBlockHeight = height;
  }

  // Mock external contract calls - always succeed for positive tests, configurable for negatives
  private mockPolicy: { active: boolean; coverageAmount: number; insured: string } = { active: true, coverageAmount: 1000000, insured: "wallet_1" };
  private mockIncident: { verified: boolean; timestamp: number; severity: number; reporter: string } = { verified: true, timestamp: Date.now(), severity: 5, reporter: "org_1" };
  private mockOracleConfirmed = true;
  private mockVaultFundsAvailable = true;
  private mockPayoutSuccess = true;
  private mockDisputeId = 1;

  // Allow configuring mocks for failure scenarios
  private setMockPolicy(active: boolean, coverage: number, insured: string) {
    this.mockPolicy = { active, coverageAmount: coverage, insured };
  }

  private setMockIncident(verified: boolean) {
    this.mockIncident.verified = verified;
  }

  private setMockOracle(confirmed: boolean) {
    this.mockOracleConfirmed = confirmed;
  }

  private setMockVault(available: boolean) {
    this.mockVaultFundsAvailable = available;
  }

  private setMockPayout(success: boolean) {
    this.mockPayoutSuccess = success;
  }

  submitClaim(caller: string, policyId: number, incidentId: number, amount: number, evidenceHash: string, description: string): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    if (amount <= 0 || amount > this.MAX_CLAIM_AMOUNT) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (!this.mockPolicy.active || this.mockPolicy.insured !== caller) {
      return { ok: false, value: this.ERR_INVALID_PARAMS };
    }
    if (!this.mockIncident) {
      return { ok: false, value: this.ERR_INVALID_PARAMS };
    }

    const claimId = ++this.state.claimCounter;
    this.state.claims.set(claimId, {
      policyId,
      incidentId,
      claimant: caller,
      amount,
      status: this.CLAIM_STATUS_PENDING,
      submitBlock: this.currentBlockHeight,
      processBlock: null,
      evidenceHash,
      description,
    });
    return { ok: true, value: claimId };
  }

  processClaim(claimId: number): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const claim = this.state.claims.get(claimId);
    if (!claim) {
      return { ok: false, value: this.ERR_INVALID_CLAIM };
    }
    if (claim.status !== this.CLAIM_STATUS_PENDING || claim.processBlock !== null) {
      return { ok: false, value: this.ERR_CLAIM_ALREADY_PROCESSED };
    }
    if (this.currentBlockHeight - claim.submitBlock > this.CLAIM_WINDOW_BLOCKS) {
      return { ok: false, value: this.ERR_CLAIM_EXPIRED };
    }
    if (!this.mockPolicy.active) {
      return { ok: false, value: this.ERR_POLICY_INACTIVE };
    }
    if (!this.mockIncident.verified) {
      return { ok: false, value: this.ERR_INCIDENT_NOT_VERIFIED };
    }
    if (!this.mockOracleConfirmed) {
      return { ok: false, value: this.ERR_ORACLE_NOT_CONFIRMED };
    }
    if (claim.amount > this.mockPolicy.coverageAmount) {
      claim.status = this.CLAIM_STATUS_REJECTED;
      claim.processBlock = this.currentBlockHeight;
      this.state.claims.set(claimId, claim);
      return { ok: true, value: this.CLAIM_STATUS_REJECTED };
    }

    if (!this.mockVaultFundsAvailable) {
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }

    if (!this.mockPayoutSuccess) {
      // Simulate release funds
      return { ok: false, value: 999 }; // Mock payout error
    }

    claim.status = this.CLAIM_STATUS_APPROVED;
    claim.processBlock = this.currentBlockHeight;
    this.state.claims.set(claimId, claim);
    return { ok: true, value: this.CLAIM_STATUS_APPROVED };
  }

  initiateDispute(caller: string, claimId: number, reason: string): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const claim = this.state.claims.get(claimId);
    if (!claim) {
      return { ok: false, value: this.ERR_INVALID_CLAIM };
    }
    const dispute = this.state.disputes.get(claimId) || { disputeId: null, initiator: "", reason: "", resolved: false };
    if (claim.status === this.CLAIM_STATUS_PENDING || dispute.resolved) {
      return { ok: false, value: this.ERR_DISPUTE_IN_PROGRESS };
    }
    if (claim.processBlock === null || this.currentBlockHeight - claim.processBlock > this.DISPUTE_WINDOW_BLOCKS) {
      return { ok: false, value: this.ERR_CLAIM_EXPIRED };
    }

    const disputeId = this.mockDisputeId;
    this.state.disputes.set(claimId, { disputeId, initiator: caller, reason, resolved: false });
    claim.status = this.CLAIM_STATUS_DISPUTED;
    this.state.claims.set(claimId, claim);
    return { ok: true, value: disputeId };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.owner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.owner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  getClaimDetails(claimId: number): ClarityResponse<ClaimRecord | null> {
    return { ok: true, value: this.state.claims.get(claimId) ?? null };
  }

  getClaimStatus(claimId: number): ClarityResponse<number> {
    const claim = this.state.claims.get(claimId);
    if (!claim) {
      return { ok: false, value: this.ERR_INVALID_CLAIM };
    }
    return { ok: true, value: claim.status };
  }

  getDisputeDetails(claimId: number): ClarityResponse<DisputeRecord | null> {
    return { ok: true, value: this.state.disputes.get(claimId) ?? null };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  claimant: "wallet_1",
  other: "wallet_2",
};

describe("ClaimsProcessor Contract", () => {
  let contract: ClaimsProcessorMock;

  beforeEach(() => {
    contract = new ClaimsProcessorMock();
    vi.resetAllMocks();
    contract.setBlockHeight(1000);
    contract.setMockPolicy(true, 1000000, accounts.claimant);
    contract.setMockIncident(true);
    contract.setMockOracle(true);
    contract.setMockVault(true);
    contract.setMockPayout(true);
  });

  it("should allow valid claim submission", () => {
    const result = contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "Incident description");
    expect(result).toEqual({ ok: true, value: 1 });

    const details = contract.getClaimDetails(1);
    expect(details).toEqual({
      ok: true,
      value: expect.objectContaining({
        amount: 500000,
        status: 0,
        submitBlock: 1000,
        processBlock: null,
      }),
    });
  });

  it("should prevent submission with invalid amount", () => {
    const result = contract.submitClaim(accounts.claimant, 1, 1, 0, "evidencehash", "desc");
    expect(result).toEqual({ ok: false, value: 107 });
  });

  it("should prevent submission when paused", () => {
    contract.pauseContract(accounts.deployer);
    const result = contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "desc");
    expect(result).toEqual({ ok: false, value: 111 });
  });

  it("should process claim and approve if conditions met", () => {
    contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "desc");
    const result = contract.processClaim(1);
    expect(result).toEqual({ ok: true, value: 1 });

    const status = contract.getClaimStatus(1);
    expect(status).toEqual({ ok: true, value: 1 });
  });

  it("should reject claim if amount exceeds coverage", () => {
    contract.submitClaim(accounts.claimant, 1, 1, 2000000, "evidencehash", "desc");
    const result = contract.processClaim(1);
    expect(result).toEqual({ ok: true, value: 2 });

    const status = contract.getClaimStatus(1);
    expect(status).toEqual({ ok: true, value: 2 });
  });

  it("should prevent processing expired claim", () => {
    contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "desc");
    contract.setBlockHeight(1000 + 145); // Beyond window
    const result = contract.processClaim(1);
    expect(result).toEqual({ ok: false, value: 108 });
  });

  it("should fail processing if oracle not confirmed", () => {
    contract.setMockOracle(false);
    contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "desc");
    const result = contract.processClaim(1);
    expect(result).toEqual({ ok: false, value: 109 });
  });

  it("should fail processing if insufficient funds", () => {
    contract.setMockVault(false);
    contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "desc");
    const result = contract.processClaim(1);
    expect(result).toEqual({ ok: false, value: 104 });
  });

  it("should allow initiating dispute on processed claim", () => {
    contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "desc");
    contract.processClaim(1);
    const result = contract.initiateDispute(accounts.claimant, 1, "Disagree with rejection");
    expect(result).toEqual({ ok: true, value: 1 });

    const status = contract.getClaimStatus(1);
    expect(status).toEqual({ ok: true, value: 3 });

    const dispute = contract.getDisputeDetails(1);
    expect(dispute).toEqual({
      ok: true,
      value: expect.objectContaining({ resolved: false }),
    });
  });

  it("should prevent dispute on pending claim", () => {
    contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "desc");
    const result = contract.initiateDispute(accounts.claimant, 1, "reason");
    expect(result).toEqual({ ok: false, value: 106 });
  });

  it("should prevent dispute after window", () => {
    contract.submitClaim(accounts.claimant, 1, 1, 500000, "evidencehash", "desc");
    contract.processClaim(1);
    contract.setBlockHeight(1000 + 721);
    const result = contract.initiateDispute(accounts.claimant, 1, "reason");
    expect(result).toEqual({ ok: false, value: 108 });
  });

  it("should allow owner to pause and unpause", () => {
    let result = contract.pauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    result = contract.unpauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent non-owner from pausing", () => {
    const result = contract.pauseContract(accounts.other);
    expect(result).toEqual({ ok: false, value: 100 });
  });
});