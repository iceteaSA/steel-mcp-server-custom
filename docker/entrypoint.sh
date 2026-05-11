#!/bin/sh
set -e

# =============================================================================
# Custom Steel Browser Entrypoint
# Handles: fingerprint fix, unified fingerprint generation, CapSolver config
# All patches are idempotent — safe across docker restart.
# =============================================================================

BUILD_DATE=$(cat /app/patches/.build-date 2>/dev/null || echo "unknown")
echo "[steel-custom] Build: $BUILD_DATE"

CDP_SERVICE="/app/api/build/services/cdp/cdp.service.js"
INJECT_TEMPLATE="/app/api/extensions/stealth-extra/inject.js.template"
INJECT_TARGET="/app/api/extensions/stealth-extra/inject.js"

# --- 1. Fix fingerprint generation (force macOS — trusted by anti-bot systems) ---
# Idempotent: only patches if "linux" is still present (skips if already "macos")
if grep -q 'operatingSystems: \["linux"\]' "$CDP_SERVICE" 2>/dev/null; then
    sed -i 's/operatingSystems: \["linux"\]/operatingSystems: ["macos"]/g' "$CDP_SERVICE"
    echo "[steel-custom] Patched fingerprint generator: forced macOS"
fi

# --- 2. Generate ONE unified fingerprint ---
# On first start, save the original inject.js as a template for future restarts.
# On restarts, always copy the template back before patching — ensures the
# __FP_CONFIG__ = null marker is present for replacement.
if [ ! -f "$INJECT_TEMPLATE" ]; then
    cp "$INJECT_TARGET" "$INJECT_TEMPLATE"
fi
cp "$INJECT_TEMPLATE" "$INJECT_TARGET"

node -e "
const { FingerprintGenerator } = require('/app/api/node_modules/fingerprint-generator');
const fs = require('fs');

const gen = new FingerprintGenerator({
  devices: ['desktop'],
  operatingSystems: ['macos'],
  browsers: [{ name: 'chrome', minVersion: 125 }],
  locales: ['en-ZA', 'en'],
  screen: { minWidth: 1920, minHeight: 1080, maxWidth: 1920, maxHeight: 1080 },
});

const fpResult = gen.getFingerprint();
const { fingerprint } = fpResult;
const nav = fingerprint.navigator;
const videoCard = fingerprint.videoCard || {};
const uaData = nav.userAgentData || {};

// a) Save full fingerprint for Steel's CDPService
fs.writeFileSync('/tmp/steel-unified-fingerprint.json', JSON.stringify(fpResult));

// b) Extract config for stealth-extra extension
const config = {
  userAgent: nav.userAgent,
  platform: nav.platform || 'MacIntel',
  vendor: nav.vendor || 'Google Inc.',
  deviceMemory: nav.deviceMemory || 8,
  hardwareConcurrency: nav.hardwareConcurrency || 8,
  maxTouchPoints: nav.maxTouchPoints || 0,
  languages: nav.languages || ['en-ZA', 'en'],
  webglVendor: videoCard.vendor || 'Google Inc. (Apple)',
  webglRenderer: videoCard.renderer || 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
  brands: uaData.brands || [{ brand: 'Chromium', version: '130' }, { brand: 'Google Chrome', version: '130' }, { brand: 'Not?A_Brand', version: '99' }],
  uaPlatform: uaData.platform || 'macOS',
  uaMobile: uaData.mobile || false,
  platformVersion: uaData.platformVersion || '14.5.0',
  architecture: uaData.architecture || 'arm',
  bitness: uaData.bitness || '64',
  uaFullVersion: nav.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] || '130.0.0.0',
};

// Replace the placeholder in the freshly-copied template
const injectPath = '$INJECT_TARGET';
let injectSrc = fs.readFileSync(injectPath, 'utf8');
injectSrc = injectSrc.replace('const __FP_CONFIG__ = null;', 'const __FP_CONFIG__ = ' + JSON.stringify(config) + ';');
fs.writeFileSync(injectPath, injectSrc);
console.log('[steel-custom] Unified FP: ' + config.platform + ' / Chrome ' + config.uaFullVersion + ' / ' + config.webglRenderer.substring(0, 50));
" 2>&1 || echo "[steel-custom] WARNING: fingerprint generation failed"

# --- 2b. Patch CDPService to load our pre-generated fingerprint ---
# Idempotent: only inserts if the marker comment is not already present.
FP_FILE="/tmp/steel-unified-fingerprint.json"
if [ -f "$FP_FILE" ] && ! grep -q 'steel-custom.*unified fingerprint' "$CDP_SERVICE" 2>/dev/null; then
    sed -i '/this\.fingerprintData = fingerprint ?? null;/a\
                // [steel-custom] Load unified fingerprint from entrypoint\
                if (!this.fingerprintData) { try { const _fs = await import("fs"); this.fingerprintData = JSON.parse(_fs.default.readFileSync("'"$FP_FILE"'", "utf8")); this.logger.info("[CDPService] Loaded unified fingerprint from entrypoint"); } catch(e) { this.logger.warn("[CDPService] Failed to load unified fingerprint: " + e.message); } }' "$CDP_SERVICE"
    echo "[steel-custom] CDPService patched to use unified fingerprint"
fi

# --- 3. Pre-configure CapSolver extension ---
if [ -n "$CAPSOLVER_API_KEY" ]; then
    CAPSOLVER_CONFIG="/app/api/extensions/capsolver/assets/config.js"
    if [ -f "$CAPSOLVER_CONFIG" ]; then
        cat > "$CAPSOLVER_CONFIG" << 'JSEOF'
var defined_config = {
    apiKey: 'CAPSOLVER_API_KEY_PLACEHOLDER',
    appId: '',
    useCapsolver: true,
    manualSolving: false,
    enabledForRecaptcha: true,
    enabledForRecaptchaV3: true,
    enabledForHCaptcha: true,
    enabledForGeetestV4: true,
    enabledForCloudflare: true,
    enabledForAwsCaptcha: true,
    enabledForImageToText: true,
    enabledForDataDome: true,
    reCaptchaMode: 'token',
    reCaptcha3Mode: 'token',
    reCaptcha3TaskType: 'ReCaptchaV3TaskProxyLess',
    hCaptchaMode: 'token',
    cloudflareMode: 'token',
    awsCaptchaMode: 'token',
    textCaptchaMode: 'click',
    funCaptchaMode: 'token',
    geetestMode: 'token',
    datadomeMode: 'token',
    reCaptchaDelayTime: 0,
    reCaptcha3DelayTime: 0,
    hCaptchaDelayTime: 0,
    cloudflareDelayTime: 0,
    awsDelayTime: 0,
    textCaptchaDelayTime: 0,
    funCaptchaDelayTime: 0,
    geetestDelayTime: 0,
    datadomeDelayTime: 0,
    reCaptchaRepeatTimes: 10,
    reCaptcha3RepeatTimes: 10,
    hCaptchaRepeatTimes: 10,
    cloudflareRepeatTimes: 10,
    awsRepeatTimes: 10,
    textCaptchaRepeatTimes: 10,
    funCaptchaRepeatTimes: 10,
    geetestRepeatTimes: 10,
    datadomeRepeatTimes: 10,
    reCaptchaCollapse: false,
    reCaptcha3Collapse: false,
    hCaptchaCollapse: false,
    cloudflareCollapse: false,
    awsCollapse: false,
    textCaptchaCollapse: false,
    funCaptchaCollapse: false,
    geetestCollapse: false,
    datadomeCollapse: false,
    showSolveButton: true,
    useProxy: false,
    enabledForBlacklistControl: false,
    blackUrlList: [],
    solvedCallback: 'captchaSolvedCallback',
    onDetectedCallback: 'onDetectedCallback',
    solvedFailedCallback: 'solvedFailedCallback'
};
JSEOF
        sed -i "s|CAPSOLVER_API_KEY_PLACEHOLDER|${CAPSOLVER_API_KEY}|g" "$CAPSOLVER_CONFIG"
        echo "[steel-custom] CapSolver configured with API key"
    fi
else
    echo "[steel-custom] No CAPSOLVER_API_KEY — CAPTCHA solving disabled"
fi

# --- 4. Hand off to original Steel entrypoint ---
exec /app/api/entrypoint.sh "$@"
