// Renders public/{index,sms-consent,privacy,terms}.html from templates/
// using venue.config.json. Re-run after editing either.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'venue.config.json'), 'utf8'));
const templatesDir = path.join(root, 'templates');
const outDir = path.join(root, 'public');

for (const file of fs.readdirSync(templatesDir)) {
  const template = fs.readFileSync(path.join(templatesDir, file), 'utf8');
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in config)) throw new Error(`venue.config.json is missing "${key}" (used in templates/${file})`);
    return config[key];
  });
  fs.writeFileSync(path.join(outDir, file), rendered);
  console.log(`wrote public/${file}`);
}
