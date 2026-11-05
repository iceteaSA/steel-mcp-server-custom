export function chromeContains(declared, requested) {
  const parse = (pattern) => {
    const match = /^(\*|https?):\/\/(\[[^\]]+\]|[^/:]+)(?::(\*|\d+))?(\/.*)$/.exec(pattern);
    if (!match) throw new Error(`bad pattern ${pattern}`);
    return {
      schemes: match[1] === "*" ? ["http", "https"] : [match[1]],
      host: match[2].replace(/^\*\./, ""),
      subdomains: match[2] === "*" || match[2].startsWith("*."),
      port: match[3] ?? "*",
      path: match[4],
    };
  };
  const matchesPath = (outer, inner) => {
    const escaped = outer
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(inner.replace(/\*$/, ""));
  };
  const one = (outer, inner) =>
    inner.schemes.every((scheme) => outer.schemes.includes(scheme)) &&
    (outer.host === "*" ||
      outer.host === inner.host ||
      (outer.subdomains && inner.host.endsWith(`.${outer.host}`))) &&
    (!inner.subdomains || outer.subdomains) &&
    (outer.port === "*" || outer.port === inner.port) &&
    matchesPath(outer.path, inner.path);
  const pool = declared.map(parse);
  return requested.every((pattern) => pool.some((outer) => one(outer, parse(pattern))));
}
