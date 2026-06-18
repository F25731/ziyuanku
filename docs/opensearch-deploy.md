# OpenSearch optional deployment

The default deployment still uses MySQL FULLTEXT. Use this optional compose file only when keyword search needs a dedicated search engine.

## Start with OpenSearch

```bash
cd /opt/lanzou-hub
git pull
docker compose -f docker-compose.yml -f docker-compose.search.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.search.yml logs -f app
```

## Build the search index

Run this once after OpenSearch starts:

```bash
docker compose -f docker-compose.yml -f docker-compose.search.yml exec app npm run reindex:search
```

After that, normal sync writes changes into `search_index_outbox`, and the app worker keeps OpenSearch updated.

## Small server notes

OpenSearch needs memory. On a 2 GB VPS, keep these defaults first:

```env
SEARCH_SHARDS=1
SEARCH_REPLICAS=0
OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
```

If memory becomes tight, keep using the default MySQL mode and only use cursor paging, Redis search cache, and short-keyword protection.
