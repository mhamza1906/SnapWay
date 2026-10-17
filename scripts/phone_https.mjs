#!/usr/bin/env node
// HTTPS dev server for testing /capture on a physical phone (getUserMedia needs a
// secure context). Development only: generates a local certificate into the
// git-ignored local/certs/ and runs `ng serve` on 0.0.0.0 with --ssl.
//
//   node scripts/phone_https.mjs cert            create/refresh the certificate only
//   node scripts/phone_https.mjs serve [--port N] [--host H] [--ip A.B.C.D ...] [--proxy-config F]
//   node scripts/phone_https.mjs info            print URLs and the CA file to install
//
// From apps/web: `npm run start:phone` (= serve) and `npm run cert:phone` (= cert).
// mkcert is used when installed (its root CA is then the one to trust); otherwise
// openssl creates a small local CA plus a server certificate signed by it.
// Nothing is installed into any system or browser trust store by this script.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "apps", "web");
const CERT_DIR = join(ROOT, "local", "certs");
const CA_KEY = join(CERT_DIR, "snapway-dev-ca-key.pem");
const CA_PEM = join(CERT_DIR, "snapway-dev-ca.pem");
const CA_CRT = join(CERT_DIR, "snapway-dev-ca.crt"); // same PEM, phone-friendly extension
const KEY = join(CERT_DIR, "phone-key.pem");
const CERT = join(CERT_DIR, "phone-cert.pem");
const META = join(CERT_DIR, "phone-cert.json");
const DEFAULT_PORT = 4443;

function parseArgs(argv) {
  const options = {
    command: "serve",
    port: DEFAULT_PORT,
    host: "0.0.0.0",
    proxyConfig: "proxy.conf.json",
    ips: [],
    passthrough: [],
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) options.command = rest.shift();
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--port") options.port = Number(rest.shift());
    else if (arg === "--host") options.host = rest.shift();
    else if (arg === "--ip") options.ips.push(rest.shift());
    else if (arg === "--proxy-config") options.proxyConfig = rest.shift();
    else if (arg === "--") options.passthrough.push(...rest.splice(0));
    else options.passthrough.push(arg);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (!["cert", "serve", "info"].includes(options.command)) {
    throw new Error(`Unknown command "${options.command}" (use cert, serve or info)`);
  }
  return options;
}

function lanIPv4() {
  const found = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
        found.push(address.address);
      }
    }
  }
  return [...new Set(found)];
}

function which(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function readMeta() {
  try {
    return JSON.parse(readFileSync(META, "utf8"));
  } catch {
    return null;
  }
}

function certValidForADay() {
  const openssl = which("openssl");
  if (!openssl || !existsSync(CERT)) return false;
  return spawnSync(openssl, ["x509", "-checkend", "86400", "-noout", "-in", CERT]).status === 0;
}

function ensureOpensslCa(openssl) {
  if (existsSync(CA_KEY) && existsSync(CA_PEM)) {
    const stillValid = spawnSync(openssl, ["x509", "-checkend", "86400", "-noout", "-in", CA_PEM]).status === 0;
    if (stillValid) return false;
  }
  const config = join(CERT_DIR, "ca.cnf");
  writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      `CN = SnapWay local dev CA (${hostname().replace(/[^A-Za-z0-9 ._-]/g, "")})`,
      "O = SnapWay development (not for production)",
      "[v3_ca]",
      "basicConstraints = critical, CA:TRUE, pathlen:0",
      "keyUsage = critical, keyCertSign, cRLSign",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  run(openssl, [
    "req", "-x509", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
    "-keyout", CA_KEY, "-out", CA_PEM, "-config", config, "-extensions", "v3_ca",
  ]);
  chmodSync(CA_KEY, 0o600);
  copyFileSync(CA_PEM, CA_CRT);
  return true;
}

function issueWithOpenssl(openssl, names) {
  const caCreated = ensureOpensslCa(openssl);
  const csr = join(CERT_DIR, "phone.csr");
  const ext = join(CERT_DIR, "phone-ext.cnf");
  const san = names.map((name) => (/^[\d.]+$|:/.test(name) ? `IP:${name}` : `DNS:${name}`)).join(", ");
  writeFileSync(
    ext,
    [
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = ${san}`,
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid, issuer",
      "",
    ].join("\n"),
  );
  run(openssl, [
    "req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-keyout", KEY, "-out", csr, "-subj", "/CN=SnapWay dev server",
  ]);
  chmodSync(KEY, 0o600);
  const serial = `0x${randomBytes(16).toString("hex")}`;
  // 397 days keeps the leaf inside the browser/Apple TLS validity limits.
  run(openssl, [
    "x509", "-req", "-in", csr, "-CA", CA_PEM, "-CAkey", CA_KEY, "-set_serial", serial,
    "-sha256", "-days", "397", "-out", CERT, "-extfile", ext,
  ]);
  return { caFile: CA_CRT, caCreated };
}

function issueWithMkcert(mkcert, names) {
  run(mkcert, ["-cert-file", CERT, "-key-file", KEY, ...names]);
  chmodSync(KEY, 0o600);
  const caRoot = run(mkcert, ["-CAROOT"]).trim();
  return { caFile: join(caRoot, "rootCA.pem"), caCreated: false };
}

function ensureCertificate(extraIps) {
  mkdirSync(CERT_DIR, { recursive: true });
  const ips = [...new Set([...lanIPv4(), ...extraIps])];
  const names = ["localhost", "127.0.0.1", "::1", ...ips];
  const mkcert = process.env.SNAPWAY_CERT_TOOL === "openssl" ? null : which("mkcert");
  const tool = mkcert ? "mkcert" : "openssl";
  const meta = readMeta();
  const covered = meta && meta.tool === tool && names.every((name) => meta.names.includes(name));
  if (covered && existsSync(KEY) && certValidForADay()) {
    return { ...meta, reused: true };
  }
  const openssl = which("openssl");
  if (!mkcert && !openssl) {
    throw new Error("Neither mkcert nor openssl is on PATH; install one to create a dev certificate.");
  }
  const issued = mkcert ? issueWithMkcert(mkcert, names) : issueWithOpenssl(openssl, names);
  const next = { tool, names, caFile: issued.caFile, createdAt: new Date().toISOString() };
  writeFileSync(META, `${JSON.stringify(next, null, 2)}\n`);
  return { ...next, reused: false, caCreated: issued.caCreated };
}

function printInfo(cert, port, host) {
  const ips = cert.names.filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name) && name !== "127.0.0.1");
  console.log(`\nCertificate (${cert.tool}${cert.reused ? ", reused" : ", new"}): ${CERT}`);
  console.log(`  covers: ${cert.names.join(", ")}`);
  console.log(`CA to install on the phone (public certificate only): ${cert.caFile}`);
  if (cert.tool === "openssl") console.log(`  keep private, never copy to a phone: ${CA_KEY}`);
  if (cert.caCreated) console.log("  NOTE: a NEW CA was created; phones that trusted an older one must install this one.");
  console.log(`\nOpen on the phone (same Wi-Fi), host ${host}, port ${port}:`);
  for (const ip of ips) console.log(`  https://${ip}:${port}/capture`);
  console.log(`  On this Mac: https://localhost:${port}/capture`);
  console.log(
    `Django must trust these origins: start it with the default LAN detection or set\n` +
      `  DEV_EXTRA_ORIGINS=${ips.map((ip) => `https://${ip}:${port}`).join(",") || `https://<LAN-IP>:${port}`}\n` +
      `(restart Django after the LAN IP changes). See docs/photo-capture.md.\n`,
  );
}

function serve(options, cert) {
  const ng = join(WEB, "node_modules", "@angular", "cli", "bin", "ng.js");
  if (!existsSync(ng)) throw new Error("Run `npm ci` in apps/web first (Angular CLI not installed).");
  const args = [
    ng, "serve",
    "--host", options.host,
    "--port", String(options.port),
    "--ssl", "--ssl-cert", CERT, "--ssl-key", KEY,
    "--proxy-config", options.proxyConfig,
    ...options.passthrough,
  ];
  printInfo(cert, options.port, options.host);
  const child = spawn(process.execPath, args, { cwd: WEB, stdio: "inherit" });
  const stop = (signal) => child.kill(signal);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code, signal) => process.exit(signal ? 130 : (code ?? 0)));
}

try {
  const options = parseArgs(process.argv.slice(2));
  const cert = ensureCertificate(options.ips);
  if (options.command === "serve") serve(options, cert);
  else printInfo(cert, options.port, options.host);
} catch (error) {
  console.error(`phone_https: ${error.message}`);
  process.exit(1);
}
