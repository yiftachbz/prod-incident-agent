import "dotenv/config";
import Fastify from "fastify";

const PORT = Number(process.env.SERVER_PORT ?? 3001);

// ---------------------------------------------------------------------------
// Coverage database — zip codes where each 5G segment is available
// ---------------------------------------------------------------------------
const COVERAGE_DB = {
  "5G SA":  ["94105", "94102", "60601", "77001", "30301"],
  "5G NSA": ["94105", "94102", "10019", "60601", "77001", "30301"],
};

// ---------------------------------------------------------------------------
// checkNetworkCoverageByZipCode
// Returns true when the requested segment is available at the given zip code.
// ---------------------------------------------------------------------------
function checkNetworkCoverageByZipCode(zipCode, segment) {
  const coveredZips = COVERAGE_DB[segment.trim()] ?? [];
  return coveredZips.includes(String(zipCode).trim());
}

// ---------------------------------------------------------------------------
const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, service: "netprovision-server" }));

// ---------------------------------------------------------------------------
// POST /api/provision
// ---------------------------------------------------------------------------
app.post("/api/provision", {
  schema: {
    body: {
      type: "object",
      required: ["name", "segment", "zipCode"],
      properties: {
        name:    { type: "string", minLength: 1 },
        segment: { type: "string", minLength: 1 },
        zipCode: { type: "string", minLength: 1 },
      },
    },
  },
}, async (req, reply) => {
  const { name, segment, zipCode } = req.body;

  const hasCoverage = checkNetworkCoverageByZipCode(zipCode, segment);
  
  if (!hasCoverage) {
    return reply.code(400).send({
      ok: false,
      code: "COVERAGE_UNAVAILABLE",
      message: `No ${segment} coverage available in your domestic service area.`,
      detail:
        `The requested network segment "${segment}" could not be provisioned for zip code ${zipCode}. ` +
        "No coverage is available in this area.",
      requestId: `REQ-${Date.now()}`,
      segment,
      zipCode,
    });
  }

  return reply.send({
    ok: true,
    message: "Provisioning successful",
    name,
    segment,
    zipCode,
  });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
