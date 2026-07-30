// Posts a photo + caption to the bar's Facebook Page and linked Instagram
// Business account via the Meta Graph API. Instagram's API requires the
// image be reachable at a public URL (no direct binary upload), so callers
// pass a URL the app is already serving rather than a file.

const axios = require('axios');

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

async function postToFacebook(imageUrl, caption) {
  const { data } = await axios.post(`${GRAPH_API_BASE}/${process.env.FB_PAGE_ID}/photos`, null, {
    params: {
      url: imageUrl,
      caption,
      access_token: process.env.FB_PAGE_ACCESS_TOKEN,
    },
  });
  return data.post_id || data.id;
}

async function postToInstagram(imageUrl, caption) {
  const igUserId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

  const container = await axios.post(`${GRAPH_API_BASE}/${igUserId}/media`, null, {
    params: { image_url: imageUrl, caption, access_token: accessToken },
  });

  const publish = await axios.post(`${GRAPH_API_BASE}/${igUserId}/media_publish`, null, {
    params: { creation_id: container.data.id, access_token: accessToken },
  });

  return publish.data.id;
}

// Posts to both platforms independently — one failing doesn't block the other.
// Returns { facebook: { success, id? , error? }, instagram: { success, id?, error? } }
async function postPhoto(imageUrl, caption) {
  if (process.env.SOCIAL_DRY_RUN === 'true') {
    console.log(`[DRY RUN] Would post to Facebook + Instagram:\n${caption}\nImage: ${imageUrl}`);
    return {
      facebook: { success: true, id: 'dry-run' },
      instagram: { success: true, id: 'dry-run' },
    };
  }

  const [facebook, instagram] = await Promise.all([
    postToFacebook(imageUrl, caption)
      .then((id) => ({ success: true, id }))
      .catch((err) => ({ success: false, error: err.response?.data?.error?.message || err.message })),
    postToInstagram(imageUrl, caption)
      .then((id) => ({ success: true, id }))
      .catch((err) => ({ success: false, error: err.response?.data?.error?.message || err.message })),
  ]);

  return { facebook, instagram };
}

module.exports = { postPhoto };
