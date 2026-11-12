#!/usr/bin/env sh
# Starts a throwaway SeaweedFS (S3 API on ${STORAGE_PORT:-8333}) with the development
# credentials in s3.json and creates the bucket. Used by CI for the storage contract test.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
port="${STORAGE_PORT:-8333}"
name="${STORAGE_CONTAINER:-veyra-storage-ci}"
docker run -d --name "$name" -p "$port:8333" \
  -v "$here/s3.json:/etc/seaweedfs/s3.json:ro" \
  chrislusf/seaweedfs:4.48 \
  server -ip.bind=0.0.0.0 -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$name" sh -c \
      "echo 's3.bucket.create -name veyra-dev' | weed shell -master=localhost:9333 -filer=localhost:8888" \
      2>/dev/null | grep -q 'created bucket veyra-dev'; then
    echo "Storage ready on port $port"
    exit 0
  fi
  sleep 2
done
echo "Storage did not start" >&2
docker logs "$name" >&2
exit 1
