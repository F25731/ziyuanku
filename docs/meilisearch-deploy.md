# Meilisearch optional deployment

The default deployment can still use MySQL FULLTEXT. For larger resource libraries, enable Meilisearch as a lightweight search index.

Meilisearch stores only:

- `id`
- `file_name`
- `source_id`
- `file_type`

All rich resource metadata stays in MySQL. Search returns IDs first, then the app fetches details from MySQL in batch.

## Start Meilisearch

Set a key in `.env`:

```env
MEILI_MASTER_KEY=change_me_to_a_long_random_string
```

Start the search stack:

```bash
cd /opt/lanzou-hub
git pull
docker compose -f docker-compose.yml -f docker-compose.search.yml up -d --build
```

Check status:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml ps
docker compose -f docker-compose.yml -f docker-compose.search.yml logs --tail=80 meilisearch
```

## Rebuild the index

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app npm run reindex:search
```

Full reindex waits for each Meilisearch task by default and retries transient write failures such as connection resets. This is slower than fire-and-forget writes, but safer for million-level and larger imports.

Resume after interruption:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app npm run reindex:search -- --resume
```

Reset checkpoint and rebuild from the beginning:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app npm run reindex:search -- --reset
```

## Outbox worker

When `docker-compose.search.yml` is enabled, the app disables its built-in search worker and starts a separate container:

```text
lrh-search-worker
```

It runs:

```bash
npm run search:outbox
```

This keeps API traffic and indexing traffic separated.

## Dumps

Meilisearch data lives in the `meili_data` Docker volume. To create a dump:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app \
  node -e "fetch('http://meilisearch:7700/dumps',{method:'POST',headers:{Authorization:'Bearer '+process.env.MEILI_MASTER_KEY}}).then(r=>r.text()).then(console.log)"
```

Keep MySQL backups as the source of truth. Meilisearch can always be rebuilt from MySQL.
