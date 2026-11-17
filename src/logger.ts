/**
 * Logger en memoria y alertas. Copiado de index.ts de ec4toast-node y movido a
 * un modulo para que el receptor (hook.ts) lo comparta.
 *
 *  - Las ultimas 500 lineas quedan en memoria y se sirven en /api/logs.
 *  - Todo console.error dispara un POST a ALERT_WEBHOOK_URL.
 *  - console.debug no se guarda ni se imprime salvo con LOG_DEBUG=true: los
 *    eventos ignorados de Olo (usuarios, Rails, dispatch...) llegan seguido y
 *    no deben empujar fuera del buffer las lineas que importan.
 */

export const logMemory: any[] = [];

let instalado = false;

export function instalarLogger(etiqueta: string): void {
    if (instalado) return;
    instalado = true;

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalDebug = console.debug;

    function saveLog(level: string, message: any, ...optionalParams: any[]) {
        const text = [message, ...optionalParams]
            .map(i => typeof i === 'object' ? JSON.stringify(i) : i)
            .join(' ');
        logMemory.unshift({ timestamp: new Date().toISOString(), level, text });
        if (logMemory.length > 500) logMemory.pop();
        return text;
    }

    console.log = function (message?: any, ...optionalParams: any[]) {
        saveLog('INFO', message, ...optionalParams);
        originalLog.apply(console, [message, ...optionalParams]);
    };

    console.warn = function (message?: any, ...optionalParams: any[]) {
        saveLog('WARN', message, ...optionalParams);
        originalWarn.apply(console, [message, ...optionalParams]);
    };

    console.debug = function (message?: any, ...optionalParams: any[]) {
        if (process.env.LOG_DEBUG !== 'true') return;
        saveLog('DEBUG', message, ...optionalParams);
        originalDebug.apply(console, [message, ...optionalParams]);
    };

    console.error = function (message?: any, ...optionalParams: any[]) {
        const text = saveLog('ERROR', message, ...optionalParams);
        originalError.apply(console, [message, ...optionalParams]);

        if (process.env.ALERT_WEBHOOK_URL) {
            const tenantName = process.env.TENANT_NAME || "Node Desconocido";
            fetch(process.env.ALERT_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subject: `ALERTA: ${tenantName} (${etiqueta})`,
                    message: text.substring(0, 1500),
                    content: `**ALERTA (${tenantName} - ${etiqueta})**
\`\`\`text
${text.substring(0, 1500)}
\`\`\``
                })
            })
            // originalError a proposito: console.error aca seria recursion
            // infinita si el propio webhook falla.
            .then(async (res) => {
                if (!res.ok) originalError(`Webhook rechazado (HTTP ${res.status}):`, await res.text());
            })
            .catch(e => originalError("Fallo el envio del webhook:", e));
        }
    };

    // Prisma devuelve BigInt en los ids y JSON.stringify no sabe serializarlo.
    // Number() como en ec4toast-node: son ids autoincrementales de MySQL, lejos
    // de 2^53. Los ids de Olo nunca pasan por aca: viven como string.
    (BigInt.prototype as any).toJSON = function () {
        return Number(this);
    };
}
