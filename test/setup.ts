/**
 * Tests run against an invented persona, never a real candidate's data.
 * CORPUS_DIR and the .env path are read when their modules are first imported,
 * so both are set here, before any test file loads.
 */
import { join } from "node:path";

process.env.CORPUS_DIR ??= join(import.meta.dir, "fixtures", "corpus");
process.env.CURRICULUM_ENV_FILE ??= join(import.meta.dir, "fixtures", "applicant.env");
