import { getStore } from '@netlify/blobs';

// The page asks this every few seconds: is my image ready yet?
export default async (req) => {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!/^[a-z0-9]{16,40}$/.test(id)) return Response.json({ status: 'error', error: 'Bad request.' }, { status: 400 });

    const store = getStore('results');
    const data = await store.get(id, { type: 'json' });
    if (!data) return Response.json({ status: 'pending' });

    // Delete the photo result once it has been handed over, to protect privacy.
    if (data.status === 'done' || data.status === 'error') await store.delete(id);
    return Response.json(data);
};
