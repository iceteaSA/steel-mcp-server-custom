# Custom Steel Browser — adds CAPTCHA solving, advanced stealth, and profile management
# Built on top of the official Steel Browser image.
FROM ghcr.io/steel-dev/steel-browser:latest

# --- CapSolver extension (downloaded at build time, layer cached by version) ---
ARG CAPSOLVER_VERSION=1.17.0
ADD https://github.com/capsolver/capsolver-browser-extension/releases/download/v.${CAPSOLVER_VERSION}/CapSolver.Browser.Extension-chrome-v${CAPSOLVER_VERSION}.zip /tmp/capsolver.zip
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && unzip -q /tmp/capsolver.zip -d /app/api/extensions/capsolver \
    && rm /tmp/capsolver.zip \
    && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# --- Stealth Extra extension (our custom code) ---
# Canvas/audio noise, WebGL spoofing, navigator overrides, Client Hints
COPY extensions/stealth-extra /app/api/extensions/stealth-extra

# --- Entrypoint ---
COPY entrypoint.sh /app/patches/entrypoint.sh
RUN chmod +x /app/patches/entrypoint.sh

LABEL org.opencontainers.image.title="steel-browser-custom" \
      org.opencontainers.image.description="Steel Browser + CapSolver + stealth-extra"
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/patches/.build-date

ENTRYPOINT ["/app/patches/entrypoint.sh"]
