// Renders {index,sms-consent,privacy,terms}.html from templates/ using a
// venue config. Re-run after editing either.
//
// Usage: node scripts/generate-compliance-pages.js [configFile] [outDir]
// Defaults to venue.config.json -> public/ (Last Resort, the original
// single-tenant setup). Pass a different config + a subdirectory of
// public/ to generate a second venue's pages (e.g. Duck & Dive) without
// touching the first venue's live pages:
//   node scripts/generate-compliance-pages.js venue.duckdive.config.json public/duck-dive
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const configFile = process.argv[2] || 'venue.config.json';
const outDirArg = process.argv[3] || 'public';

const config = JSON.parse(fs.readFileSync(path.join(root, configFile), 'utf8'));
// A venue can pick a template subfolder (e.g. "shift-only") via "templateSet" in its config.
const templatesDir = path.join(root, 'templates', config.templateSet || '');
const outDir = path.join(root, outDirArg);
fs.mkdirSync(outDir, { recursive: true });

for (const file of fs.readdirSync(templatesDir).filter((f) => f.endsWith('.html'))) {
  const template = fs.readFileSync(path.join(templatesDir, file), 'utf8');
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in config)) throw new Error(`${configFile} is missing "${key}" (used in templates/${file})`);
    return config[key];
  });
  // Venues without their own logo file set "showLogo": false in their config.
  const withLogo = config.showLogo === false
    ? rendered.replace(/<!--LOGO-->[\s\S]*?<!--\/LOGO-->/g, '')
    : rendered.replace(/<!--LOGO-->|<!--\/LOGO-->/g, '');
  fs.writeFileSync(path.join(outDir, file), withLogo);
  console.log(`wrote ${outDirArg}/${file}`);
}
