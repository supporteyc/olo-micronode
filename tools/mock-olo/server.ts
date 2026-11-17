/**
 * Mock de Olo como proceso aparte: `bun run mock:olo`.
 * Puerto MOCK_OLO_PORT (4010 por defecto). Ver tools/mock-olo/mockOlo.ts.
 */
import { crearMockOlo } from './mockOlo';

const mock = crearMockOlo({
    port: Number(process.env.MOCK_OLO_PORT || 4010),
    clientId: process.env.OLO_CLIENT_ID || 'mock-client-id',
    clientSecret: process.env.OLO_CLIENT_SECRET || 'mock-client-secret',
    vendorId: process.env.OLO_VENDOR_ID || '10000000000000001'
});

console.log(`Mock de Olo escuchando en ${mock.baseUrl}`);
console.log(`  86 a mano: curl -X POST ${mock.url}/__admin/86 -d '{"products":["90000000000000012"],"choices":["90000000000000022"]}'`);
console.log(`  fallas:    curl -X POST ${mock.url}/__admin/modo -d '{"modo86":"403"}'`);
