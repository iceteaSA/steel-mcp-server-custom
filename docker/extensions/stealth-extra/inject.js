/**
 * Stealth Extra v2 — Full JS-level fingerprint + noise injection.
 * Steel handles UA at the HTTP/network level via CDP.
 * This extension handles ALL JavaScript-visible properties because Steel's
 * page.evaluateOnNewDocument only applies to its primary page, not MCP pages.
 *
 * Config is injected inline by entrypoint.sh at container startup.
 * Runs in MAIN world at document_start across ALL frames and pages.
 */
(() => {
  "use strict";

  // Replaced at startup by entrypoint.sh with generated fingerprint JSON.
  const __FP_CONFIG__ = null;

  const cfg = __FP_CONFIG__ || {
    platform: "MacIntel",
    vendor: "Google Inc.",
    deviceMemory: 8,
    hardwareConcurrency: 10,
    maxTouchPoints: 0,
    languages: ["en-ZA", "en"],
    webglVendor: "Google Inc. (Apple)",
    webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
    brands: [{ brand: "Chromium", version: "130" }, { brand: "Google Chrome", version: "130" }, { brand: "Not?A_Brand", version: "99" }],
    uaPlatform: "macOS",
    uaMobile: false,
    platformVersion: "14.5.0",
    architecture: "arm",
    bitness: "64",
    uaFullVersion: "130.0.0.0",
  };

  // Session-stable noise seed
  const seed = Math.random() * 10000;
  function noise(x) {
    const n = Math.sin(seed + x) * 10000;
    return n - Math.floor(n) - 0.5;
  }

  // -------------------------------------------------------------------------
  // Navigator property overrides
  // -------------------------------------------------------------------------
  const navProps = {
    platform: cfg.platform,
    vendor: cfg.vendor,
    deviceMemory: cfg.deviceMemory,
    hardwareConcurrency: cfg.hardwareConcurrency,
    maxTouchPoints: cfg.maxTouchPoints,
    languages: cfg.languages,
    language: (cfg.languages && cfg.languages[0]) || "en-US",
    webdriver: false,
  };
  // Also override userAgent at JS level if provided
  if (cfg.userAgent) navProps.userAgent = cfg.userAgent;

  for (const [prop, value] of Object.entries(navProps)) {
    try {
      Object.defineProperty(Navigator.prototype, prop, {
        get: () => value,
        configurable: true,
      });
    } catch (e) { /* skip if not configurable */ }
  }

  // -------------------------------------------------------------------------
  // Plugins + MimeTypes (headless Chrome has none — spoof standard set)
  // -------------------------------------------------------------------------
  try {
    const pluginData = [
      { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    ];
    const mimeData = [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
    ];

    // Build fake Plugin objects
    const fakePlugins = pluginData.map((p) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { get: () => p.name },
        filename: { get: () => p.filename },
        description: { get: () => p.description },
        length: { get: () => mimeData.length },
      });
      return plugin;
    });

    // Build fake PluginArray
    const fakePluginArray = Object.create(PluginArray.prototype);
    Object.defineProperty(fakePluginArray, "length", { get: () => fakePlugins.length });
    fakePlugins.forEach((p, i) => {
      Object.defineProperty(fakePluginArray, i, { get: () => p, enumerable: true });
      Object.defineProperty(fakePluginArray, p.name, { get: () => p });
    });
    fakePluginArray.item = (i) => fakePlugins[i] || null;
    fakePluginArray.namedItem = (name) => fakePlugins.find((p) => p.name === name) || null;
    fakePluginArray.refresh = () => {};
    fakePluginArray[Symbol.iterator] = function* () { yield* fakePlugins; };

    Object.defineProperty(Navigator.prototype, "plugins", {
      get: () => fakePluginArray,
      configurable: true,
    });

    // Build fake MimeTypeArray
    const fakeMimeTypes = mimeData.map((m) => {
      const mt = Object.create(MimeType.prototype);
      Object.defineProperties(mt, {
        type: { get: () => m.type },
        suffixes: { get: () => m.suffixes },
        description: { get: () => m.description },
        enabledPlugin: { get: () => fakePlugins[0] },
      });
      return mt;
    });
    const fakeMimeArray = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(fakeMimeArray, "length", { get: () => fakeMimeTypes.length });
    fakeMimeTypes.forEach((m, i) => {
      Object.defineProperty(fakeMimeArray, i, { get: () => m, enumerable: true });
      Object.defineProperty(fakeMimeArray, m.type, { get: () => m });
    });
    fakeMimeArray.item = (i) => fakeMimeTypes[i] || null;
    fakeMimeArray.namedItem = (name) => fakeMimeTypes.find((m) => m.type === name) || null;
    fakeMimeArray[Symbol.iterator] = function* () { yield* fakeMimeTypes; };

    Object.defineProperty(Navigator.prototype, "mimeTypes", {
      get: () => fakeMimeArray,
      configurable: true,
    });
  } catch (e) { /* */ }

  // -------------------------------------------------------------------------
  // UserAgentData (Client Hints API)
  // -------------------------------------------------------------------------
  if (typeof NavigatorUAData !== "undefined" || navigator.userAgentData) {
    try {
      const uaDataObj = {
        brands: cfg.brands || [],
        mobile: cfg.uaMobile || false,
        platform: cfg.uaPlatform || "macOS",
        toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
        getHighEntropyValues: async (hints) => {
          const r = { brands: cfg.brands, mobile: cfg.uaMobile, platform: cfg.uaPlatform };
          for (const h of hints) {
            if (h === "platformVersion") r.platformVersion = cfg.platformVersion || "14.5.0";
            if (h === "architecture") r.architecture = cfg.architecture || "arm";
            if (h === "bitness") r.bitness = cfg.bitness || "64";
            if (h === "model") r.model = "";
            if (h === "uaFullVersion") r.uaFullVersion = cfg.uaFullVersion || "130.0.0.0";
            if (h === "fullVersionList") r.fullVersionList = (cfg.brands || []).map(b => ({...b}));
            if (h === "wow64") r.wow64 = false;
          }
          return r;
        },
      };
      if (typeof NavigatorUAData !== "undefined") {
        Object.setPrototypeOf(uaDataObj, NavigatorUAData.prototype);
      }
      Object.defineProperty(Navigator.prototype, "userAgentData", {
        get: () => uaDataObj,
        configurable: true,
      });
    } catch (e) { /* */ }
  }

  // -------------------------------------------------------------------------
  // WebGL vendor/renderer override
  // Handles case where --disable-gpu is replaced by swiftshader but the
  // reported GPU (SwiftShader/ANGLE) needs to look like real hardware.
  // -------------------------------------------------------------------------
  if (cfg.webglVendor && cfg.webglRenderer) {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const ctx = origGetContext.call(this, type, ...args);
      if (ctx && (type === "webgl" || type === "webgl2" || type === "experimental-webgl")) {
        const origGetParam = ctx.getParameter.bind(ctx);
        const origGetExt = ctx.getExtension.bind(ctx);

        ctx.getExtension = function (name) {
          if (name === "WEBGL_debug_renderer_info") {
            return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
          }
          return origGetExt(name);
        };

        ctx.getParameter = function (param) {
          if (param === 0x9245 || param === 0x1F00) return cfg.webglVendor;
          if (param === 0x9246 || param === 0x1F01) return cfg.webglRenderer;
          try { return origGetParam(param); } catch (e) { return null; }
        };
      }
      return ctx;
    };
  }

  // -------------------------------------------------------------------------
  // Canvas noise injection
  // -------------------------------------------------------------------------
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  function perturbCanvas(canvas) {
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const imageData = origGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      // Skip mostly-transparent canvases (fingerprint detectors check this)
      let nonZero = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) nonZero++;
      }
      if (nonZero < 10) return; // Canvas is empty/transparent — don't noise
      const stride = Math.max(1, Math.floor(data.length / 80));
      for (let i = 0; i < data.length; i += stride) {
        // Only modify RGB of non-transparent pixels (skip alpha channel)
        if (i % 4 !== 3 && data[i + (3 - (i % 4))] > 0) {
          data[i] = Math.max(0, Math.min(255, data[i] + noise(i) * 2));
        }
      }
      ctx.putImageData(imageData, 0, 0);
    } catch (e) { /* CORS tainted */ }
  }

  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    perturbCanvas(this);
    return origToDataURL.apply(this, args);
  };

  HTMLCanvasElement.prototype.toBlob = function (...args) {
    perturbCanvas(this);
    return origToBlob.apply(this, args);
  };

  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const imageData = origGetImageData.apply(this, args);
    const data = imageData.data;
    // Count non-transparent pixels — skip noise on empty canvases
    let nonZero = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) nonZero++;
    }
    if (nonZero < 10) return imageData;
    const stride = Math.max(1, Math.floor(data.length / 50));
    for (let i = 0; i < data.length; i += stride) {
      if (i % 4 !== 3 && data[i + (3 - (i % 4))] > 0) {
        data[i] = Math.max(0, Math.min(255, data[i] + noise(i) * 1.5));
      }
    }
    return imageData;
  };

  // -------------------------------------------------------------------------
  // AudioContext noise
  // -------------------------------------------------------------------------
  const origGetChannelData = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = function (...args) {
    const data = origGetChannelData.apply(this, args);
    if (data.length < 10000) {
      for (let i = 0; i < data.length; i += 100) {
        data[i] += noise(i) * 0.0001;
      }
    }
    return data;
  };

  if (typeof AnalyserNode !== "undefined") {
    const origFloat = AnalyserNode.prototype.getFloatFrequencyData;
    if (origFloat) {
      AnalyserNode.prototype.getFloatFrequencyData = function (array) {
        origFloat.call(this, array);
        for (let i = 0; i < array.length; i += 10) {
          array[i] += noise(i) * 0.1;
        }
      };
    }
  }

  // -------------------------------------------------------------------------
  // Intl locale override — Chrome's --lang flag doesn't fully propagate to
  // Intl.DateTimeFormat/NumberFormat resolvedOptions().locale. Override the
  // constructors to default to the fingerprint's language.
  // -------------------------------------------------------------------------
  const fpLocale = (cfg.languages && cfg.languages[0]) || "en-ZA";
  try {
    const OrigDTF = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function (locales, options) {
      return new OrigDTF(locales || fpLocale, options);
    };
    Intl.DateTimeFormat.prototype = OrigDTF.prototype;
    Intl.DateTimeFormat.supportedLocalesOf = OrigDTF.supportedLocalesOf;
    Object.defineProperty(Intl.DateTimeFormat, "length", { value: 0 });

    const OrigNF = Intl.NumberFormat;
    Intl.NumberFormat = function (locales, options) {
      return new OrigNF(locales || fpLocale, options);
    };
    Intl.NumberFormat.prototype = OrigNF.prototype;
    Intl.NumberFormat.supportedLocalesOf = OrigNF.supportedLocalesOf;
    Object.defineProperty(Intl.NumberFormat, "length", { value: 0 });
  } catch (e) { /* */ }
})();
