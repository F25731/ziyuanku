# Manticore optional deployment

The default deployment can still use MySQL FULLTEXT. For larger resource libraries, enable Manticore as a lightweight external search index.

Manticore stores only:

- `id`
- `file_name`
- `source_id`
- `file_type`

Resource details still come from MySQL after search returns IDs. This keeps the search index small and lets MySQL remain the source of truth.

## Start Manticore

Add the search compose file when starting the stack:

```bash
cd /opt/lanzou-hub
docker compose -f docker-compose.yml -f docker-compose.search.yml up -d --build
```

The search compose file sets:

```env
SEARCH_ENGINE=manticore
MANTICORE_URL=http://manticore:9308
MANTICORE_INDEX=lrh_resources
MANTICORE_BATCH_SIZE=1000
MANTICORE_RETRY_ATTEMPTS=5
```

If the server has more RAM, you can raise the Manticore memory limit in `.env`:

```env
MANTICORE_MEMORY_LIMIT=3g
MANTICORE_BATCH_SIZE=2000
```

## Verify

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml ps
docker compose -f docker-compose.yml -f docker-compose.search.yml logs --tail=80 manticore
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app node -e "fetch('http://manticore:9308/sql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'SHOW TABLES'})}).then(r=>r.text()).then(console.log)"
```

## Build The Index

Use the admin panel:

1. Open `/admin/dashboard.html`.
2. Go to `搜索索引`.
3. Click `全量重建`.

The panel shows Manticore health, indexed documents, MySQL resource count, outbox queue size, current scan job, and job history. It can start full rebuilds, incremental scans, pause a running job, resume from the saved checkpoint, and retry failed outbox items.

You can also run the CLI reindexer:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app npm run reindex:search -- 2000
```

Resume from the checkpoint:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app npm run reindex:search -- 2000 --resume
```

## Notes

- Manticore index data lives in the `manticore_data` Docker volume.
- Full rebuilds are resumable through `search_index_jobs`.
- New or changed resources are written through `search_index_outbox`.
- Empty searches and resource management pagination still use MySQL cursor queries.
- Keep MySQL backups. Manticore can always be rebuilt from MySQL.
