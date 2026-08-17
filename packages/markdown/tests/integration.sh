#!/usr/bin/env bash
# Integration test for unidocs-markdown local dev server
set -euo pipefail

BASE="http://localhost:8787"
PASS=0
FAIL=0
DOC_ID="test-integration-$(date +%s)"

pass() { PASS=$((PASS + 1)); echo "✅ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "❌ $1 — $2"; }
assert_eq() { [ "$1" = "$2" ] && pass "$3" || fail "$3" "expected '$2', got '$1'"; }

echo "═══════════════════════════════════════"
echo " unidocs-markdown integration tests"
echo "═══════════════════════════════════════"
echo ""

# 1. Create empty document
echo "--- Create & Init ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/create" -H "X-Doc-Id: $DOC_ID")
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "create returns 200"
assert_eq "$(echo "$BODY" | jq -r .success)" "true" "create success=true"
assert_eq "$(echo "$BODY" | jq -r .version)" "1" "create version=1"

# 2. Query empty content
echo ""
echo "--- Query (empty doc) ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "query empty doc 200"
assert_eq "$(echo "$BODY" | jq -r .data)" "" "query empty doc data=''"
assert_eq "$(echo "$BODY" | jq -r .version)" "1" "query empty doc version=1"

# 3. Apply setContent
echo ""
echo "--- Apply setContent ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{"operations":[{"kind":"setContent","payload":{"content":"# Hello World\n\nThis is a test document.\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B."}}],"description":"Set initial content","baseVersion":1}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "apply setContent 200"
V2=$(echo "$BODY" | jq -r .version)
assert_eq "$V2" "2" "apply setContent version=2"

# 4. Query getHeadings
echo ""
echo "--- Query getHeadings ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getHeadings"}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "query getHeadings 200"
HEADINGS=$(echo "$BODY" | jq -r '.data | join(",")')
assert_eq "$HEADINGS" "Hello World,Section A,Section B" "getHeadings returns 3 headings"

# 5. Query getSection
echo ""
echo "--- Query getSection ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getSection","payload":{"heading":"Section A"}}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "query getSection 200"
SECTION=$(echo "$BODY" | jq -r .data)
echo "$SECTION" | grep -q "Content A" && pass "getSection contains 'Content A'" || fail "getSection" "missing 'Content A' in: $SECTION"

# 6. Apply appendSection
echo ""
echo "--- Apply appendSection ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{"operations":[{"kind":"appendSection","payload":{"heading":"Section C","content":"Content C."}}],"description":"Add Section C","baseVersion":2}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "apply appendSection 200"
V3=$(echo "$BODY" | jq -r .version)
assert_eq "$V3" "3" "apply appendSection version=3"

# 7. Optimistic lock conflict
echo ""
echo "--- Conflict detection ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{"operations":[{"kind":"setContent","payload":{"content":"conflict"}}],"description":"stale","baseVersion":1}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "409" "stale baseVersion returns 409"
echo "$BODY" | jq -r .error | grep -q "Version conflict" && pass "409 error message contains 'Version conflict'" || fail "409 error msg" "$(echo "$BODY" | jq -r .error)"

# 8. Multi-op delta (transactional)
echo ""
echo "--- Multi-op delta ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{"operations":[{"kind":"replaceSection","payload":{"heading":"Section B","content":"Updated B."}},{"kind":"deleteSection","payload":{"heading":"Section A"}}],"description":"Replace B, delete A","baseVersion":3}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "multi-op delta 200"
V4=$(echo "$BODY" | jq -r .version)
assert_eq "$V4" "4" "multi-op delta version=4"

# 9. Verify multi-op result
echo ""
echo "--- Verify multi-op result ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
CONTENT=$(echo "$BODY" | jq -r .data)
echo "$CONTENT" | grep -q "Updated B" && pass "content has 'Updated B'" || fail "multi-op verify" "missing 'Updated B'"
echo "$CONTENT" | grep -q "Section A" && fail "Section A should be deleted" "still present" || pass "Section A deleted"
echo "$CONTENT" | grep -q "Section C" && pass "Section C still present" || fail "Section C missing" "Section C not found"

# 10. History
echo ""
echo "--- History ---"
R=$(curl -s -w "\n%{http_code}" -X GET "$BASE/$DOC_ID/history")
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "history 200"
COUNT=$(echo "$BODY" | jq '.data | length')
assert_eq "$COUNT" "4" "history has 4 deltas (create + 3 applies)"

# 11. Rollback to v1 (empty doc)
echo ""
echo "--- Rollback to v1 ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/rollback" \
  -H "Content-Type: application/json" \
  -d '{"version":1}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "rollback 200"
V5=$(echo "$BODY" | jq -r .version)
echo "$V5" | grep -qE '^[0-9]+$' && [ "$V5" -gt 4 ] && pass "rollback version=$V5 (> 4)" || fail "rollback version" "expected >4, got $V5"

# 12. Verify rollback content
echo ""
echo "--- Verify rollback ---"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
ROLLBACK_CONTENT=$(echo "$BODY" | jq -r .data)
assert_eq "$ROLLBACK_CONTENT" "" "rollback to v1 = empty content"

# 13. Export
echo ""
echo "--- Export ---"
R=$(curl -s -w "\n%{http_code}" -X GET "$BASE/$DOC_ID/export")
CODE=$(echo "$R" | tail -1)
assert_eq "$CODE" "200" "export 200"

# 14. Snapshot (for clone)
echo ""
echo "--- Snapshot ---"
R=$(curl -s -w "\n%{http_code}" -X GET "$BASE/$DOC_ID/snapshot")
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "snapshot 200"
SNAP_HASH=$(echo "$BODY" | jq -r .hash)
SNAP_VER=$(echo "$BODY" | jq -r .version)
echo "    snapshot hash=$SNAP_HASH version=$SNAP_VER"
[ -n "$SNAP_HASH" ] && [ "$SNAP_HASH" != "null" ] && pass "snapshot has hash" || fail "snapshot hash" "null/empty"

# 15. Clone via init_from_hash
echo ""
echo "--- Clone ---"
CLONE_ID="clone-${DOC_ID}"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/create" -H "X-Doc-Id: $CLONE_ID")
CODE=$(echo "$R" | tail -1)
assert_eq "$CODE" "200" "clone target create 200"

# We need to use the Editor DO's init_from_hash directly
# Since the standalone worker routes /{docId}/init_from_hash, let's use that
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$CLONE_ID/init_from_hash" \
  -H "Content-Type: application/json" \
  -d "{\"hash\":\"$SNAP_HASH\",\"sourceVersion\":$SNAP_VER}")
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
# The clone target already exists (we just created it), so it should return 409
assert_eq "$CODE" "409" "clone to existing doc returns 409"

# Create a fresh clone target
CLONE_ID2="clone2-${DOC_ID}"
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$CLONE_ID2/init_from_hash" \
  -H "Content-Type: application/json" \
  -d "{\"hash\":\"$SNAP_HASH\",\"sourceVersion\":$SNAP_VER}")
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "200" "clone init_from_hash 200"

# 16. Transactional failure (second op fails → whole delta rejected)
echo ""
echo "--- Transactional failure ---"
# First re-set content so we have something to work with
R=$(curl -s -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d "{\"operations\":[{\"kind\":\"setContent\",\"payload\":{\"content\":\"# Recovery\\n\\nBack to work.\"}}],\"description\":\"Recover\",\"baseVersion\":$V5}")
V6=$(echo "$R" | jq -r .version)

# Now try a delta where second op fails (deleteSection on non-existent heading)
R=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d "{\"operations\":[{\"kind\":\"setContent\",\"payload\":{\"content\":\"# Should not persist\"}},{\"kind\":\"deleteSection\",\"payload\":{\"heading\":\"NonExistent\"}}],\"description\":\"should fail\",\"baseVersion\":$V6}")
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | head -n -1)
assert_eq "$CODE" "400" "transactional failure returns 400"

# Verify content unchanged
R=$(curl -s -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
FINAL_CONTENT=$(echo "$R" | jq -r .data)
echo "$FINAL_CONTENT" | grep -q "Recovery" && pass "transactional rollback: content unchanged" || fail "transactional rollback" "content was modified: $FINAL_CONTENT"

# Summary
echo ""
echo "═══════════════════════════════════════"
echo " Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"
[ "$FAIL" -eq 0 ] && echo "🎉 All tests passed!" || echo "⚠️  Some tests failed."
exit $FAIL
