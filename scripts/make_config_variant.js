#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function parseValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  return Number.isNaN(number) ? value : number;
}

function setPath(root, dottedPath, value) {
  const parts = dottedPath.split(".");
  let obj = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof obj[key] !== "object" || obj[key] === null) obj[key] = {};
    obj = obj[key];
  }
  obj[parts[parts.length - 1]] = value;
}

function usage() {
  console.error("Usage: make_config_variant.js <base.json> <out.json> key=value ...");
  process.exit(2);
}

const [, , basePath, outPath, ...pairs] = process.argv;
if (!basePath || !outPath) usage();

const config = JSON.parse(fs.readFileSync(basePath, "utf8"));
for (const pair of pairs) {
  const eq = pair.indexOf("=");
  if (eq < 0) usage();
  const key = pair.slice(0, eq);
  const value = parseValue(pair.slice(eq + 1));
  setPath(config, key, value);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
