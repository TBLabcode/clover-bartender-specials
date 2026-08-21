// Reads a photo of a delivery/purchase receipt and extracts line items
// (product name, bottle size, bottle count) using Claude's vision API.

const axios = require('axios');

const DRY_RUN = process.env.RECEIPT_DRY_RUN === 'true';

const MOCK_LINES = [
  { name: 'GREY GOOSE 750', displayName: 'Grey Goose', code: 'GG750', sizeMl: 750, caseCount: null, unitsPerCase: null, count: 6 },
  { name: 'COORS LT 24PK CAN', displayName: 'Coors Light', code: '', sizeMl: null, rawSize: '24-pack cans', caseCount: 1, unitsPerCase: 24, count: 24 },
];

// Returns an array of line items extracted from the photo:
//   name          - the product name exactly as printed on the receipt
//   displayName   - a clean, recognizable product name (brand abbreviations expanded,
//                   e.g. "F/C" -> "Finest Call", "VDKA" -> "Vodka", "RTU" -> "Ready to Use"),
//                   used for matching against the real item catalog. Same as `name` if
//                   nothing needed expanding.
//   code          - distributor/product/SKU code printed on the line, if any ('' if none)
//   sizeMl        - bottle/can size in milliliters if determinable from the printed size
//                   (e.g. 750, 1000, 250), else null
//   rawSize       - whatever size text is printed, if sizeMl couldn't be pinned to a number
//   caseCount     - number of cases/cartons shipped, if the receipt bills by the case (else null)
//   unitsPerCase  - individual bottles/cans per case, if printed (else null)
//   count         - TOTAL individual bottles/units received. When the receipt shows a case
//                   quantity and a units-per-case count, this MUST be caseCount * unitsPerCase,
//                   not the raw case number.
async function extractReceiptLines(imageBuffer, mimeType) {
  if (DRY_RUN) {
    console.log('[DRY RUN] Would send receipt photo to Claude for extraction');
    return MOCK_LINES;
  }

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: imageBuffer.toString('base64') },
            },
            {
              type: 'text',
              text:
                'This is a photo of a delivery or purchase receipt/invoice for a bar, likely from an ' +
                'alcohol distributor. Extract every line item that represents alcohol or drink product ' +
                '(including mixers, energy drinks, garnish syrups, etc.) received. Distributor invoices ' +
                'often use heavy abbreviations (e.g. "F/C" = Finest Call, "VDKA" = Vodka, "RTU" = Ready ' +
                'to Use, "LS" = Long Sleeve/Slim can) — use your knowledge of common liquor brands and ' +
                'distributor shorthand to recognize the actual product, don\'t just transcribe letters.\n\n' +
                'For each line, identify:\n' +
                '- "name": the product name exactly as printed on the line.\n' +
                '- "displayName": a clean, human-readable product name with abbreviations expanded and ' +
                'the real brand/product identified (e.g. "F/C SWEET/SOUR RTU" -> "Finest Call Sweet & ' +
                'Sour Mix"). If you cannot confidently identify the product beyond what\'s printed, repeat ' +
                '"name" here rather than guessing.\n' +
                '- "code": the distributor/product/SKU code printed on that line, if any (a short ' +
                'alphanumeric code, separate from any UPC barcode number — empty string if none).\n' +
                '- "sizeMl": the bottle/can size in milliliters as a number if the receipt states or ' +
                'implies a metric size (e.g. "750 ML" -> 750, "1 LT" -> 1000, "250 ML" -> 250), else null.\n' +
                '- "rawSize": whatever size text is printed, if sizeMl is null or as a backup reference.\n' +
                '- "caseCount": if the invoice bills this line by the case/carton (look for a column ' +
                'labeled like "Cs", "Cases", "Ctn", "Qty"), the number of cases shipped — else null.\n' +
                '- "unitsPerCase": the TRUE total number of individual bottles/cans in ONE case. Case ' +
                'configuration is shown differently across distributors — check for all of these:\n' +
                '  (a) A plain units-per-case column (e.g. "BPC", "Pack", "Per Cs") — use that number ' +
                'directly.\n' +
                '  (b) Embedded in the product name as "X/Y" (e.g. "2/12" or "3/8"): this means X sub-' +
                'packs of Y units EACH per case, so unitsPerCase = X * Y (e.g. "2/12 12oz Bottle" = 2 ' +
                'twelve-packs per case = 24 bottles per case, NOT 12). If there\'s also a separate column ' +
                'showing total sub-packs shipped for the line (often labeled "Packs"), it should equal ' +
                'caseCount * X — use it to confirm you\'ve identified X correctly.\n' +
                '  (c) Embedded as "N/size Loose" or "N/size Lse" (e.g. "24/12 Lse Can"): here there is NO ' +
                'sub-pack — the case just holds N individual loose units directly (24 loose 12oz cans per ' +
                'case), so unitsPerCase = N, do not multiply further.\n' +
                'Get this right — it is the single most error-prone field. Show your reasoning is correct ' +
                'by making sure caseCount * unitsPerCase never contradicts a "Packs" or similar total-' +
                'sub-packs column when one is printed.\n' +
                '- "count": the TOTAL number of individual bottles/cans/units received = caseCount * ' +
                'unitsPerCase whenever both are known — never just the raw case number or the raw sub-pack ' +
                'number. If the invoice already states an individual unit/bottle quantity directly with no ' +
                'case structure at all, use that instead and leave caseCount/unitsPerCase null.\n\n' +
                'Respond with ONLY a JSON array, no other text, in this exact shape: ' +
                '[{"name": "...", "displayName": "...", "code": "...", "sizeMl": 750, "rawSize": "", ' +
                '"caseCount": null, "unitsPerCase": null, "count": 6}]',
            },
          ],
        },
      ],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  const text = (response.data.content || []).map((b) => b.text || '').join('');
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Could not find a JSON line-item list in the extraction response');
  return JSON.parse(jsonMatch[0]);
}

module.exports = { extractReceiptLines };
