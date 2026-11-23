# RDS CA bundle

`global-bundle.pem` is Amazon RDS's global CA bundle, from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem, fetched 2026-10-31 (114 root certificates, one per region, key type and generation; the earliest expiry is May 2061). It holds public certificates only: no secret and no account identifier (D-035). `global-bundle.pem.sha256` is its SHA-256.

`rds-ca-rsa2048-g1-us-east-1.pem` is one block of that bundle, unchanged: `Amazon RDS us-east-1 Root CA RSA2048 G1`, the root of the CA `rds-ca-rsa2048-g1` that the data stage pins on the instance (`ca_cert_identifier` in `deploy/sandbox/data/rds.tf`).

The image copies the bundle to `/app/rds-ca.pem` and the single root to `/app/rds-ca-prisma.pem` (`Dockerfile`). The app stage sets `DATABASE_SSL_ROOT_CERT=/app/rds-ca.pem` and `DATABASE_PRISMA_SSL_CERT=/app/rds-ca-prisma.pem`, so both database consumers verify the server's chain and host name (#57, `packages/db/src/database-url.ts`): the API's pg adapter with `sslmode=verify-full` against the bundle, the migrate task's Prisma CLI with `sslaccept=strict` against the single root. Prisma gets one root because its engine (7.10.1) trusts only the first certificate in its `sslcert` file, and the bundle's first is another region's.

`tests/scripts/rds-ca-bundle.test.ts` (unit) fails if the bundle no longer matches its checksum, holds anything but certificates, or holds a certificate that expires within 90 days, and if the single-root file is not exactly that root as the bundle holds it. The data stage's tftest checks the pin. Changing the instance's CA means changing the pin and the single-root file in one PR.

## Refresh

From this directory, then review the diff and commit the three files in one PR:

```
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o global-bundle.pem && shasum -a 256 global-bundle.pem > global-bundle.pem.sha256
```

Then extract the root again (the test fails if it differs from the bundle's block):

```
node -e 'const {X509Certificate}=require("node:crypto"),fs=require("node:fs");const b=fs.readFileSync("global-bundle.pem","utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g).filter(c=>new X509Certificate(c).subject.split("\n").includes("CN=Amazon RDS us-east-1 Root CA RSA2048 G1"));if(b.length!==1)throw new Error(b.length+" matches");fs.writeFileSync("rds-ca-rsa2048-g1-us-east-1.pem",b[0]+"\n")'
```

Update the fetch date above. The bundle changes when AWS adds a CA (for a new region or a CA rotation); a merge redeploys the image, and nothing else needs to change.
