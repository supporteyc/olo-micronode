import type { Almacen } from './almacen/tipos';
import type { ConfigOcb, ConfigOlo } from './config/olo';
import { Mutex } from './lib/mutex';
import { OloApiService } from './services/oloApi.service';
import { MenuSyncService } from './services/menuSync.service';
import { AvailabilityService } from './services/availability.service';
import { StoreHealthService } from './services/storeHealth.service';
import { OcbService } from './services/ocb.service';
import { OloEventsService } from './services/oloEvents.service';
import { StockEstado } from './services/stockEstado';
import type { VendorExportParser } from './services/vendorExport.parser';

/**
 * Arma los servicios de una tienda. En ec4toast-node cada servicio era un
 * singleton que leia process.env al importarse; aca se cablean una vez con la
 * configuracion ya validada. index.ts arma uno; cada test arma el suyo.
 */
export interface Servicios {
    almacen: Almacen;
    cfg: ConfigOlo;
    cfgOcb: ConfigOcb;
    oloApi: OloApiService;
    menuSync: MenuSyncService;
    availability: AvailabilityService;
    storeHealth: StoreHealthService;
    ocb: OcbService;
    eventos: OloEventsService;
}

export interface OpcionesContenedor {
    almacen: Almacen;
    cfg: ConfigOlo;
    cfgOcb: ConfigOcb;
    fetchImpl?: typeof fetch;
    parser?: VendorExportParser;
    reloj?: () => Date;
    dormir?: (ms: number) => Promise<void>;
}

export function crearServicios(o: OpcionesContenedor): Servicios {
    const mutex = new Mutex();
    const estado = new StockEstado();
    const oloApi = new OloApiService(o.cfg, o.fetchImpl ?? fetch, o.dormir);

    const menuSync = new MenuSyncService({
        almacen: o.almacen, oloApi, cfg: o.cfg, parser: o.parser, mutex, estado, ahora: o.reloj
    });
    const availability = new AvailabilityService({
        almacen: o.almacen,
        cfg: o.cfg,
        mutex,
        estado,
        programarVerificacion: motivo => menuSync.programarVerificacion(motivo),
        ahora: o.reloj
    });
    const storeHealth = new StoreHealthService();
    const ocb = new OcbService(o.almacen, o.cfgOcb, o.cfg.storeTimeZone, o.cfg.vendorId, o.reloj);
    const eventos = new OloEventsService({ almacen: o.almacen, cfg: o.cfg, menuSync, availability, ocb, storeHealth });

    return { almacen: o.almacen, cfg: o.cfg, cfgOcb: o.cfgOcb, oloApi, menuSync, availability, storeHealth, ocb, eventos };
}
