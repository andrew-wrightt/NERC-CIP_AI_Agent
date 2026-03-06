// ===============================
// Retrieval Evaluation Test Set (#82)
// ===============================
// This file contains test queries with expected document matches
// Run with: node scripts/eval-retrieval.js

import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test cases: each has a query and expected sources that should be retrieved
export const TEST_CASES = [
  {
    id: 1,
    query: "What is the purpose of CIP-005?",
    expectedSources: ["CIP-005"],
    description: "Should retrieve CIP-005 document chunks about purpose"
  },
  {
    id: 2,
    query: "What are the requirements for electronic security perimeters?",
    expectedSources: ["CIP-005"],
    description: "ESP requirements are defined in CIP-005"
  },
  {
    id: 3,
    query: "How should passwords be managed for BES Cyber Systems?",
    expectedSources: ["CIP-007"],
    description: "Password requirements are in CIP-007"
  },
  {
    id: 4,
    query: "What is required for security awareness training?",
    expectedSources: ["CIP-004"],
    description: "Training requirements are in CIP-004"
  },
  {
    id: 5,
    query: "What are the physical security requirements for control centers?",
    expectedSources: ["CIP-006"],
    description: "Physical security is covered in CIP-006"
  },
  {
    id: 6,
    query: "How should cyber security incidents be reported?",
    expectedSources: ["CIP-008"],
    description: "Incident reporting is in CIP-008"
  },
  {
    id: 7,
    query: "What are the recovery plan requirements?",
    expectedSources: ["CIP-009"],
    description: "Recovery plans are covered in CIP-009"
  },
  {
    id: 8,
    query: "What is configuration change management?",
    expectedSources: ["CIP-010"],
    description: "Configuration management is in CIP-010"
  },
  {
    id: 9,
    query: "How should BES Cyber System information be protected?",
    expectedSources: ["CIP-011"],
    description: "Information protection is in CIP-011"
  },
  {
    id: 10,
    query: "What are the supply chain risk management requirements?",
    expectedSources: ["CIP-013"],
    description: "Supply chain is covered in CIP-013"
  },
  {
    id: 11,
    query: "CIP-005-7 electronic access controls",
    expectedSources: ["CIP-005"],
    description: "Direct reference to CIP-005-7"
  },
  {
    id: 12,
    query: "What is a BES Cyber Asset?",
    expectedSources: ["CIP-002"],
    description: "Definitions and categorization in CIP-002"
  },
  {
    id: 13,
    query: "interactive remote access requirements",
    expectedSources: ["CIP-005"],
    description: "Remote access is covered in CIP-005"
  },
  {
    id: 14,
    query: "malicious code prevention",
    expectedSources: ["CIP-007"],
    description: "Malware prevention is in CIP-007"
  },
  {
    id: 15,
    query: "personnel risk assessment background checks",
    expectedSources: ["CIP-004"],
    description: "Personnel risk assessment in CIP-004"
  }
];

// Scoring function to evaluate retrieval quality
export function evaluateRetrieval(retrievedSources, expectedSources) {
  const retrieved = retrievedSources.map(s => {
    // Extract CIP standard ID from source string
    const match = s.match(/CIP-\d{3}/i);
    return match ? match[0].toUpperCase() : s;
  });
  
  const expected = expectedSources.map(s => s.toUpperCase());
  
  // Check if any expected source was retrieved
  const hits = expected.filter(exp => 
    retrieved.some(ret => ret.includes(exp))
  );
  
  const recall = hits.length / expected.length;
  const precision = retrieved.length > 0 ? hits.length / Math.min(retrieved.length, expected.length) : 0;
  const f1 = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
  
  return {
    hit: hits.length > 0,
    recall,
    precision,
    f1,
    retrieved,
    expected,
    hits
  };
}

// Summary statistics
export function summarizeResults(results) {
  const total = results.length;
  const hits = results.filter(r => r.hit).length;
  const avgRecall = results.reduce((sum, r) => sum + r.recall, 0) / total;
  const avgPrecision = results.reduce((sum, r) => sum + r.precision, 0) / total;
  const avgF1 = results.reduce((sum, r) => sum + r.f1, 0) / total;
  
  return {
    total,
    hits,
    hitRate: (hits / total * 100).toFixed(1) + '%',
    avgRecall: (avgRecall * 100).toFixed(1) + '%',
    avgPrecision: (avgPrecision * 100).toFixed(1) + '%',
    avgF1: (avgF1 * 100).toFixed(1) + '%'
  };
}

// Export for use in evaluation script
export default { TEST_CASES, evaluateRetrieval, summarizeResults };
