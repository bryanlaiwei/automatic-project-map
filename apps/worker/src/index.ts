import { SCHEMA_VERSION } from "@apm/shared";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log(
    `worker ready (schema ${SCHEMA_VERSION}); DATABASE_URL is unset, so no jobs are running`,
  );
} else {
  console.log(`worker ready (schema ${SCHEMA_VERSION})`);
}
