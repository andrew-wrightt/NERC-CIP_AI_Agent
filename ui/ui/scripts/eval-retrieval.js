// ===============================
// Retrieval Evaluation Runner (#82)
// ===============================
// Runs test queries against the retrieval system and reports accuracy
// Usage: node scripts/eval-retrieval.js
//
// Make sure the server is running first: npm start
// Then in another terminal: node scripts/eval-retrieval.js

import { TEST_CASES, evaluateRetrieval, summarizeResults } from "./eval-test-set.js";

const API_URL = process.env.API_URL || "http://localhost:5173";

// We need a valid auth token to test - you can get this by logging in
// For testing, we'll add a special eval endpoint that doesn't require auth
// Or you can paste a token here after logging in:
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

async function testRetrieval(query) {
  try {
    const headers = {
      "Content-Type": "application/json",
    };
    
    if (AUTH_TOKEN) {
      headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
    }
    
    const response = await fetch(`${API_URL}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: query }]
      })
    });

    if (!response.ok) {
      console.error(`API error for query "${query}": ${response.status}`);
      return [];
    }

    // Read the streaming response to get sources
    const text = await response.text();
    const lines = text.trim().split("\n");
    
    // Find the final line with sources
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.done && parsed.sources) {
          return parsed.sources.map(s => s.source || s);
        }
      } catch {
        continue;
      }
    }
    
    return [];
  } catch (error) {
    console.error(`Error testing query "${query}":`, error.message);
    return [];
  }
}

async function runEvaluation() {
  console.log("=".repeat(60));
  console.log("RETRIEVAL EVALUATION TEST");
  console.log("=".repeat(60));
  console.log(`Testing ${TEST_CASES.length} queries...\n`);

  const results = [];

  for (const testCase of TEST_CASES) {
    process.stdout.write(`Test ${testCase.id}: ${testCase.query.substring(0, 40)}... `);
    
    const retrievedSources = await testRetrieval(testCase.query);
    const evaluation = evaluateRetrieval(retrievedSources, testCase.expectedSources);
    
    results.push({
      ...testCase,
      ...evaluation
    });

    console.log(evaluation.hit ? "✓ PASS" : "✗ FAIL");
    
    if (!evaluation.hit) {
      console.log(`   Expected: ${testCase.expectedSources.join(", ")}`);
      console.log(`   Got: ${evaluation.retrieved.join(", ") || "(none)"}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  
  const summary = summarizeResults(results);
  console.log(`Total Tests:    ${summary.total}`);
  console.log(`Passed:         ${summary.hits} (${summary.hitRate})`);
  console.log(`Avg Recall:     ${summary.avgRecall}`);
  console.log(`Avg Precision:  ${summary.avgPrecision}`);
  console.log(`Avg F1 Score:   ${summary.avgF1}`);
  
  console.log("\n" + "=".repeat(60));
  console.log("FAILED TESTS");
  console.log("=".repeat(60));
  
  const failed = results.filter(r => !r.hit);
  if (failed.length === 0) {
    console.log("All tests passed!");
  } else {
    failed.forEach(f => {
      console.log(`\n#${f.id}: ${f.query}`);
      console.log(`   Description: ${f.description}`);
      console.log(`   Expected: ${f.expectedSources.join(", ")}`);
      console.log(`   Retrieved: ${f.retrieved.join(", ") || "(none)"}`);
    });
  }
  
  return { results, summary };
}

// Run if called directly
runEvaluation().catch(console.error);
