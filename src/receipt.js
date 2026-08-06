// Reads a photo of a delivery/purchase receipt and extracts line items
// (product name, bottle size, bottle count) using Claude's vision API.

const axios = require('axios');

const DRY_RUN = process.env.RECEIPT_DRY_RUN === 'true';

const MOCK_LINES = [
  { name: 'Grey Goose', code: 'GG750', sizeMl: 750, count: 6 },
  { name: 'Coors Light', code: '', sizeMl: null, rawSize: '24-pack cans', count: 1 },
];

// Returns an array of { name, code, sizeMl, count, rawSize? } extracted from the photo.
// sizeMl is 750, 1000, or null if the size can't be determined as one of those.
// code is the distributor/product code printed on the receipt, if any (empty string if none).
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
                'This is a photo of a delivery or purchase receipt for a bar. Extract every line ' +
                'item that represents alcohol or drink product received. For each line, identify: ' +
                'the product name as printed, the distributor/product/SKU code printed on that line ' +
                'if there is one (often a short alphanumeric code near the start or end of the line, ' +
                'separate from the product name — empty string if none is printed), the bottle size ' +
                'in milliliters (750 for a standard 750ml bottle, 1000 for a 1 liter bottle, or null ' +
                'if the size is something else or unclear), and the quantity of bottles/units ' +
                'received. Respond with ONLY a JSON array, no other text, in this exact shape: ' +
                '[{"name": "...", "code": "...", "sizeMl": 750, "count": 6}]. ' +
                'If sizeMl is null, include a "rawSize" field with whatever size text is printed, if any.',
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
