#!/bin/bash
# Unidocs Markdown - Local Integration Test
set -euo pipefail

BASE="http://localhost:8787"
DOC_ID="test-$(date +%s)"
PASS=0
FAIL=0
TOTAL=0

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  echo "  ✅ $1"
}

fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  echo "  ❌ $1"
}

assert_eq() {
  if [ "$1" = "$2" ]; then
    pass "$3"
  else
    fail "$3 (expected: $2, got: $1)"
  fi
}

assert_contains() {
  if echo "$1" | grep -q "$2"; then
    pass "$3"
  else
    fail "$3 (expected to contain: $2)"
  fi
}

echo "═══════════════════════════════════════"
echo "  Unidocs Markdown Integration Test"
echo "  Doc ID: $DOC_ID"
echo "═══════════════════════════════════════"
echo ""

# ── 1. Create Document ──
echo "1. CREATE document"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/create" \
  -H "X-Doc-Id: $DOC_ID" \
  -H "Content-Type: application/json")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "create returns 200"
assert_eq "$(echo "$BODY" | jq -r '.success')" "true" "create success=true"
assert_eq "$(echo "$BODY" | jq -r '.version')" "1" "initial version=1"
echo ""

# ── 2. Query empty document ──
echo "2. QUERY empty document"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "query returns 200"
assert_eq "$(echo "$BODY" | jq -r '.data')" "" "empty content"
assert_eq "$(echo "$BODY" | jq -r '.version')" "1" "version still 1"
echo ""

# ── 3. Apply setContent ──
echo "3. APPLY setContent"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{
    "baseVersion": 1,
    "description": "Initial content",
    "operations": [{
      "kind": "setContent",
      "payload": {
        "content": "# Hello World\n\nThis is the initial content.\n\n## Section A\n\nContent of A.\n\n## Section B\n\nContent of B."
      }
    }]
  }')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "apply returns 200"
assert_eq "$(echo "$BODY" | jq -r '.success')" "true" "apply success=true"
assert_eq "$(echo "$BODY" | jq -r '.version')" "2" "version=2"
echo ""

# ── 4. Query content ──
echo "4. QUERY getContent"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "query returns 200"
assert_contains "$(echo "$BODY" | jq -r '.data')" "Hello World" "content contains Hello World"
echo ""

# ── 5. Query getHeadings ──
echo "5. QUERY getHeadings"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getHeadings"}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "getHeadings returns 200"
HEADINGS=$(echo "$BODY" | jq -r '.data | join(",")')
assert_contains "$HEADINGS" "Hello World" "headings contains Hello World"
assert_contains "$HEADINGS" "Section A" "headings contains Section A"
assert_contains "$HEADINGS" "Section B" "headings contains Section B"
echo ""

# ── 6. Query getSection ──
echo "6. QUERY getSection"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getSection","payload":{"heading":"Section A"}}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "getSection returns 200"
assert_contains "$(echo "$BODY" | jq -r '.data')" "Content of A" "Section A content correct"
echo ""

# ── 7. Apply appendSection ──
echo "7. APPLY appendSection"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{
    "baseVersion": 2,
    "description": "Add section C",
    "operations": [{
      "kind": "appendSection",
      "payload": {
        "heading": "Section C",
        "content": "Content of C."
      }
    }]
  }')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "appendSection returns 200"
assert_eq "$(echo "$BODY" | jq -r '.version')" "3" "version=3"
echo ""

# ── 8. Apply multi-op delta ──
echo "8. APPLY multi-op delta (replaceSection + appendSection)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{
    "baseVersion": 3,
    "description": "Multi-op: replace A, add D",
    "operations": [
      {
        "kind": "replaceSection",
        "payload": {
          "heading": "Section A",
          "content": "Updated content of A."
        }
      },
      {
        "kind": "appendSection",
        "payload": {
          "heading": "Section D",
          "content": "Content of D."
        }
      }
    ]
  }')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "multi-op returns 200"
assert_eq "$(echo "$BODY" | jq -r '.version')" "4" "version=4"
# Verify the replace took effect
RESP2=$(curl -s -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getSection","payload":{"heading":"Section A"}}')
assert_contains "$(echo "$RESP2" | jq -r '.data')" "Updated content of A" "Section A was updated"
echo ""

# ── 9. Conflict detection (optimistic lock) ──
echo "9. CONFLICT detection (stale baseVersion)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{
    "baseVersion": 2,
    "description": "Stale write",
    "operations": [{
      "kind": "setContent",
      "payload": {"content": "should fail"}
    }]
  }')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "409" "conflict returns 409"
assert_eq "$(echo "$BODY" | jq -r '.success')" "false" "conflict success=false"
assert_contains "$(echo "$BODY" | jq -r '.error')" "Version conflict" "error mentions version conflict"
echo ""

# ── 10. Transactional failure (second op fails, whole delta rejected) ──
echo "10. TRANSACTIONAL failure"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/apply" \
  -H "Content-Type: application/json" \
  -d '{
    "baseVersion": 4,
    "description": "Bad delta",
    "operations": [
      {
        "kind": "appendSection",
        "payload": {"heading": "Section E", "content": "E content"}
      },
      {
        "kind": "replaceSection",
        "payload": {"heading": "NonExistent", "content": "should fail"}
      }
    ]
  }')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "400" "transactional failure returns 400"
assert_eq "$(echo "$BODY" | jq -r '.success')" "false" "failure success=false"
# Version should still be 4
RESP2=$(curl -s -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
assert_eq "$(echo "$RESP2" | jq -r '.version')" "4" "version unchanged after failed delta"
echo ""

# ── 11. History ──
echo "11. HISTORY"
RESP=$(curl -s -w "\n%{http_code}" "$BASE/$DOC_ID/history")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "history returns 200"
DELTA_COUNT=$(echo "$BODY" | jq '.data | length')
assert_eq "$DELTA_COUNT" "4" "4 deltas (create + setContent + appendSection + multi-op)"
FIRST_DESC=$(echo "$BODY" | jq -r '.data[0].description')
assert_eq "$FIRST_DESC" "Document created" "first delta is create"
echo ""

# ── 12. Rollback to v2 ──
echo "12. ROLLBACK to v2"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$DOC_ID/rollback" \
  -H "Content-Type: application/json" \
  -d '{"version": 2}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "rollback returns 200"
assert_eq "$(echo "$BODY" | jq -r '.success')" "true" "rollback success=true"
NEW_VER=$(echo "$BODY" | jq -r '.version')
# Version should be > 4 (rollback creates a new delta)
assert_contains "$NEW_VER" "5" "rollback creates new version"
# Content should match v2 (before appendSection/multi-op)
RESP2=$(curl -s -X POST "$BASE/$DOC_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
DATA=$(echo "$RESP2" | jq -r '.data')
assert_contains "$DATA" "Hello World" "rolled back content has Hello World"
assert_contains "$DATA" "Section A" "rolled back content has Section A"
assert_contains "$DATA" "Section B" "rolled back content has Section B"
# Should NOT have Section C or D
if echo "$DATA" | grep -q "Section C"; then
  fail "rolled back content should not have Section C"
else
  pass "Section C correctly absent after rollback"
fi
echo ""

# ── 13. Export ──
echo "13. EXPORT"
RESP=$(curl -s -w "\n%{http_code}" "$BASE/$DOC_ID/export")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "export returns 200"
assert_contains "$BODY" "Hello World" "export contains content"
echo ""

# ── 14. Snapshot ──
echo "14. SNAPSHOT"
RESP=$(curl -s -w "\n%{http_code}" "$BASE/$DOC_ID/snapshot")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "snapshot returns 200"
SNAP_HASH=$(echo "$BODY" | jq -r '.hash')
SNAP_VER=$(echo "$BODY" | jq -r '.version')
echo "     hash=$SNAP_HASH version=$SNAP_VER"
if [ -n "$SNAP_HASH" ] && [ "$SNAP_HASH" != "null" ]; then
  pass "snapshot hash is non-empty"
else
  fail "snapshot hash is empty"
fi
echo ""

# ── 15. Clone via init_from_hash ──
echo "15. CLONE via init_from_hash"
CLONE_ID="clone-$DOC_ID"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/$CLONE_ID/init_from_hash" \
  -H "Content-Type: application/json" \
  -H "X-Doc-Id: $CLONE_ID" \
  -d "{\"hash\": \"$SNAP_HASH\", \"sourceVersion\": $SNAP_VER}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_eq "$CODE" "200" "clone returns 200"
assert_eq "$(echo "$BODY" | jq -r '.success')" "true" "clone success=true"
# Verify clone has same content
RESP2=$(curl -s -X POST "$BASE/$CLONE_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"kind":"getContent"}')
CLONE_DATA=$(echo "$RESP2" | jq -r '.data')
assert_contains "$CLONE_DATA" "Hello World" "clone has Hello World"
assert_contains "$CLONE_DATA" "Section A" "clone has Section A"
echo ""

# ── Summary ──
echo "═══════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed (total: $TOTAL)"
echo "═══════════════════════════════════════"

if [ "$FAIL" -eq 0 ]; then
  echo "  🎉 All tests passed!"
  exit 0
else
  echo "  ⚠️  Some tests failed!"
  exit 1
fi
