import { buildCandidateResultSummary } from "@vulseek/server/services/scan/persistence/candidate-result-summary";
import { describe, expect, it } from "vitest";

describe("candidate result summary", () => {
	it("counts candidates without stage results without inventing result nodes", () => {
		const summary = buildCandidateResultSummary([
			{
				analysisResult: null,
				verificationResult: null,
				triageResult: null,
				count: 3,
			},
		]);

		expect(summary.counts).toEqual({
			candidatesTotal: 3,
			analysisPositive: 0,
			analysisReal: 0,
			analysisLikely: 0,
			verificationTrue: 0,
			verificationLikely: 0,
			verificationPositive: 0,
			triageSecurityIssue: 0,
		});
		expect(summary.flow.links).toEqual([]);
		expect(summary.flow.nodes.every((node) => node.count === 0)).toBe(true);
	});

	it("aggregates recognized result combinations into nodes and links", () => {
		const summary = buildCandidateResultSummary([
			{
				analysisResult: "real_vulnerability",
				verificationResult: "true",
				triageResult: "security_issue",
				count: 4,
			},
			{
				analysisResult: "likely_vulnerability",
				verificationResult: "likely",
				triageResult: "needs_review",
				count: 2,
			},
			{
				analysisResult: "plausible_but_unproven",
				verificationResult: "false",
				triageResult: "hardening",
				count: 1,
			},
		]);

		expect(summary.counts).toMatchObject({
			candidatesTotal: 7,
			analysisPositive: 6,
			analysisReal: 4,
			analysisLikely: 2,
			verificationTrue: 4,
			verificationLikely: 2,
			verificationPositive: 6,
			triageSecurityIssue: 4,
		});
		expect(summary.flow.links).toEqual(
			expect.arrayContaining([
				{
					source: "analysis_real_vulnerability",
					target: "verify_true",
					count: 4,
				},
				{
					source: "verify_true",
					target: "triage_security_issue",
					count: 4,
				},
				{
					source: "analysis_likely_vulnerability",
					target: "verify_likely",
					count: 2,
				},
				{
					source: "verify_false",
					target: "triage_hardening",
					count: 1,
				},
			]),
		);
	});

	it("ignores unknown outcomes while preserving the candidate total", () => {
		const summary = buildCandidateResultSummary([
			{
				analysisResult: "unknown_analysis",
				verificationResult: "unknown_verification",
				triageResult: "unknown_triage",
				count: 5,
			},
		]);

		expect(summary.counts.candidatesTotal).toBe(5);
		expect(summary.flow.links).toEqual([]);
		expect(summary.flow.nodes.every((node) => node.count === 0)).toBe(true);
	});

	it("does not count an orphan triage result without a verification result", () => {
		const summary = buildCandidateResultSummary([
			{
				analysisResult: "real_vulnerability",
				verificationResult: null,
				triageResult: "security_issue",
				count: 2,
			},
		]);

		expect(summary.counts.triageSecurityIssue).toBe(0);
		expect(
			summary.flow.nodes.find((node) => node.id === "triage_security_issue")
				?.count,
		).toBe(0);
		expect(summary.flow.links).toEqual([]);
	});

	it("returns links in a stable pipeline order", () => {
		const summary = buildCandidateResultSummary([
			{
				analysisResult: "likely_vulnerability",
				verificationResult: "likely",
				triageResult: "needs_review",
				count: 1,
			},
			{
				analysisResult: "real_vulnerability",
				verificationResult: "true",
				triageResult: "security_issue",
				count: 1,
			},
		]);

		expect(
			summary.flow.links.map(({ source, target }) => [source, target]),
		).toEqual([
			["analysis_real_vulnerability", "verify_true"],
			["analysis_likely_vulnerability", "verify_likely"],
			["verify_true", "triage_security_issue"],
			["verify_likely", "triage_needs_review"],
		]);
	});
});
