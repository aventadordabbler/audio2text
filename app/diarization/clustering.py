"""Bounded global clustering of the same CAM++ evidence used online."""
import json

import numpy as np
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.sparse.linalg import eigsh, ArpackError
from sklearn.cluster import KMeans


def cluster_file(path, limit=4000, max_speakers=16):
    # Keep a deterministic reservoir per online identity, including minority speakers.
    pools, counts = {}, {}
    random = np.random.default_rng(42)
    with open(path) as source:
        for line in source:
            entry = json.loads(line)
            for speaker in entry.get("evidence", []):
                if not speaker.get("embedding") or speaker.get("fresh_ms", 0) < 100:
                    continue
                key = speaker.get("speaker_id") or "unknown"
                if key not in pools and len(pools) >= max_speakers + 1:
                    key = "unknown"
                pool = pools.setdefault(key, [])
                counts[key] = counts.get(key, 0) + 1
                capacity = limit // (max_speakers + 1)
                if len(pool) < capacity:
                    pool.append(speaker["embedding"])
                else:
                    idx = int(random.integers(counts[key]))
                    if idx < capacity:
                        pool[idx] = speaker["embedding"]
    values = [vector for pool in pools.values() for vector in pool]
    if not values:
        return {"centroids": []}
    x = np.asarray(values, dtype=np.float32)
    x /= np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-8)
    if len(x) < 2:
        labels = np.zeros(len(x), dtype=int)
    elif len(x) < 40:
        labels = fcluster(linkage(x, method="average", metric="cosine"), t=0.6, criterion="distance")
    else:
        affinity = np.maximum(x @ x.T, 0)
        keep = max(6, int(len(x) * 0.012))
        indices = np.argpartition(affinity, len(x) - keep, axis=1)[:, :len(x) - keep]
        np.put_along_axis(affinity, indices, 0, axis=1)
        affinity = (affinity + affinity.T) / 2
        np.fill_diagonal(affinity, 0)
        laplacian = np.diag(np.abs(affinity).sum(1)) - affinity
        try:
            values, vectors = eigsh(laplacian, k=min(max_speakers + 1, len(x) - 1), which="SM")
            order = np.argsort(values)
            values, vectors = values[order], vectors[:, order]
            count = int(np.argmax(np.diff(values))) + 1
            labels = KMeans(n_clusters=count, random_state=42, n_init=10).fit_predict(vectors[:, :count])
        except ArpackError:
            labels = fcluster(linkage(x, method="average", metric="cosine"), t=max_speakers, criterion="maxclust")
    centers = []
    for label in sorted(np.unique(labels), key=lambda value: -int(np.count_nonzero(labels == value))):
        vector = x[labels == label].mean(0)
        vector /= max(float(np.linalg.norm(vector)), 1e-8)
        if centers and max(float(c @ vector) for c in centers) >= 0.8:
            idx = int(np.argmax([c @ vector for c in centers]))
            centers[idx] += vector
            centers[idx] /= np.linalg.norm(centers[idx])
        else:
            centers.append(vector)
    return {"centroids": [c.tolist() for c in centers[:max_speakers]], "sampled_windows": len(x)}
