# Meilisearch optional deployment

The default deployment can still use MySQL FULLTEXT. For larger resource libraries, enable Meilisearch as a lightweight external search index.

Meilisearch stores only:

- `id`
- `file_name`
- `source_id`
- `file_type`

Resource details still come from MySQL after search returns IDs. This keeps the search index small and lets MySQL remain the source of truth.

## Start Meilisearch

Add the search compose file when starting the stack:

```bash
cd /opt/lanzou-hub
docker compose -f docker-compose.yml -f docker-compose.search.yml up -d --build
```

The search compose file sets:

```env
SEARCH_ENGINE=meilisearch
MEILI_HOST=http://meilisearch:7700
MEILI_MASTER_KEY=change_me_to_a_long_random_string
MEILI_INDEX=lrh_resources
MEILI_BATCH_SIZE=1000
MEILI_RETRY_ATTEMPTS=5
```

If the server has more RAM, you can raise the Meilisearch memory limit in `.env`:

```env
MEILI_MEMORY_LIMIT=1g
MEILI_BATCH_SIZE=2000
MEILI_MAX_INDEXING_MEMORY=256Mb
MEILI_MAX_INDEXING_THREADS=1
MEILI_EXPERIMENTAL_REDUCE_INDEXING_MEMORY_USAGE=true
```

## Verify

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml ps
docker compose -f docker-compose.yml -f docker-compose.search.yml logs --tail=80 meilisearch
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app node -e "fetch('http://meilisearch:7700/health').then(r=>r.text()).then(console.log)"
```

## Build The Index

Use the admin panel:

1. Open `/admin/dashboard.html`.
2. Go to `搜索索引`.
3. Click `全量重建`.

The panel shows Meilisearch health, indexed documents, MySQL resource count, outbox queue size, current scan job, and job history. It can start full rebuilds, incremental scans, pause a running job, resume from the saved checkpoint, and retry failed outbox items.

Full/incremental scan jobs are executed by the `search-worker` container, not by the web `app` container. The same worker also drains `search_index_outbox` in a separate loop so normal incremental upserts/deletes can continue while a rebuild is running.

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml logs -f search-worker
```

You can also run the CLI reindexer:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app npm run reindex:search -- 2000
```

Resume from the checkpoint:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app npm run reindex:search -- 2000 --resume
```

## Notes

- Meilisearch index data lives in the `meili_data` Docker volume.
- Full rebuilds are resumable through `search_index_jobs`.
- New or changed resources are written through `search_index_outbox`.
- Empty searches and resource management pagination still use MySQL cursor queries.
- Keep MySQL backups. Meilisearch can always be rebuilt from MySQL.
