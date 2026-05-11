#!/bin/bash
set -euo pipefail

# Steel Browser Fingerprint Smoke Test
# Checks that HTTP-level and JS-level fingerprint properties are consistent.
# Usage: ./smoke-test.sh [steel-url]

STEEL_URL="${1:-http://localhost:3000}"

echo "=== Steel Browser Fingerprint Smoke Test ==="
echo "Steel URL: $STEEL_URL"

# 1. Check Steel is healthy
echo -n "[1/5] Health check... "
if curl -sf "$STEEL_URL/" > /dev/null 2>&1; then
  echo "OK"
else
  echo "FAIL — Steel not reachable at $STEEL_URL"
  exit 1
fi

# 2. Check entrypoint logs for fingerprint generation
echo -n "[2/5] Entrypoint logs... "
LOGS=$(docker logs steel 2>&1 | grep "\[steel-custom\]" || true)
if echo "$LOGS" | grep -q "Fingerprint:"; then
  FP_PLATFORM=$(echo "$LOGS" | grep "Fingerprint:" | tail -1 | grep -oP 'MacIntel|Win32|Linux')
  echo "OK (platform=$FP_PLATFORM)"
else
  echo "WARN — no fingerprint log found"
  FP_PLATFORM="unknown"
fi

# 3. Create a session and evaluate JS fingerprint
echo -n "[3/5] JS fingerprint check... "
JS_RESULT=$(node -e "
const { spawn } = require('child_process');
const c = spawn('node', [process.env.MCP_SERVER_PATH || './dist/index.cjs'], {
  env: { ...process.env, BROWSER_MODE: 'steel', STEEL_BASE_URL: '$STEEL_URL', OUTPUT_DIR: '/tmp/steel-smoke' },
  stdio: ['pipe', 'pipe', 'pipe']
});
const s = m => c.stdin.write(JSON.stringify(m) + '\n');
let o = '';
c.stdout.on('data', d => { o += d.toString(); });
s({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'smoke',version:'1'}}});
setTimeout(() => s({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'go_to_url',arguments:{url:'https://httpbin.org/get'}}}), 1000);
setTimeout(() => s({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'evaluate',arguments:{expression:\`JSON.stringify({
  jsUA: navigator.userAgent,
  platform: navigator.platform,
  langs: navigator.languages,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  webdriver: navigator.webdriver,
  plugins: navigator.plugins.length,
  webgl: (() => { const c=document.createElement('canvas'); const gl=c.getContext('webgl'); return gl ? 'yes' : 'no'; })(),
})\`}}}), 8000);
setTimeout(() => {
  c.kill();
  const rs = o.split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const r = rs.find(x => x.id === 3);
  if (r?.result?.content) console.log(r.result.content.map(x=>x.text).join(''));
  else console.log('ERROR: no result');
}, 12000);
" 2>&1 | tail -1)

if echo "$JS_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0)" 2>/dev/null; then
  echo "OK"
else
  echo "FAIL — could not parse JS result"
  echo "$JS_RESULT"
  exit 1
fi

# 4. Parse and validate
echo -n "[4/5] Consistency checks... "
ERRORS=0

PLATFORM=$(echo "$JS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['platform'])")
UA=$(echo "$JS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['jsUA'])")
TZ=$(echo "$JS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['tz'])")
WEBDRIVER=$(echo "$JS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['webdriver'])")
PLUGINS=$(echo "$JS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['plugins'])")
WEBGL=$(echo "$JS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['webgl'])")

# Platform matches UA
if echo "$UA" | grep -q "Macintosh" && [ "$PLATFORM" = "MacIntel" ]; then
  : # match
elif echo "$UA" | grep -q "Windows" && [ "$PLATFORM" = "Win32" ]; then
  : # match
else
  echo -n "MISMATCH(platform=$PLATFORM vs UA) "
  ERRORS=$((ERRORS + 1))
fi

# Webdriver must be false
if [ "$WEBDRIVER" != "False" ]; then
  echo -n "LEAK(webdriver=$WEBDRIVER) "
  ERRORS=$((ERRORS + 1))
fi

# Must have plugins
if [ "$PLUGINS" -lt 3 ]; then
  echo -n "WARN(plugins=$PLUGINS) "
fi

# WebGL must work
if [ "$WEBGL" != "yes" ]; then
  echo -n "WARN(webgl=$WEBGL) "
fi

# Timezone
if [ "$TZ" != "Africa/Johannesburg" ]; then
  echo -n "WARN(tz=$TZ) "
fi

if [ "$ERRORS" -eq 0 ]; then
  echo "PASS"
else
  echo "FAIL ($ERRORS errors)"
fi

# 5. Summary
echo ""
echo "[5/5] Summary:"
echo "  UA:       $UA"
echo "  Platform: $PLATFORM"
echo "  TZ:       $TZ"
echo "  Webdriver: $WEBDRIVER"
echo "  Plugins:  $PLUGINS"
echo "  WebGL:    $WEBGL"
echo ""
echo "Result: $([ "$ERRORS" -eq 0 ] && echo 'ALL CHECKS PASSED' || echo "$ERRORS ERRORS FOUND")"
exit $ERRORS
