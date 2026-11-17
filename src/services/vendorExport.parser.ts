import { XMLParser } from 'fast-xml-parser';

/**
 * Parser del Vendor Export de Olo, aislado detras de una interfaz.
 *
 * SYNTHETIC: no tenemos el XSD del Vendor Export [PEDIR-A-ANDRES]. La forma
 * que lee este parser sale de los nombres de campo de la documentacion
 * (category, product, optiongroup, option, pricing, cost, chain ids) y de un
 * fixture sintetico armado a mano: fixtures/vendor-export/synthetic.xml. El dia
 * que llegue el XSD o un export real, lo unico que cambia es este archivo: el
 * resto del servicio consume MenuOlo.
 *
 * Para tolerar la forma real sin reescribir, cada campo se busca primero como
 * atributo y despues como elemento hijo (<product id="1"> o <product><id>1</id>).
 */

export interface OpcionOlo {
    id: string;
    chainId: string | null;
    nombre: string;
    costo: number | null;
    gruposOpciones: GrupoOpcionesOlo[];
}

export interface GrupoOpcionesOlo {
    id: string;
    nombre: string;
    opciones: OpcionOlo[];
}

export interface ProductoOlo {
    id: string;
    chainId: string | null;
    nombre: string;
    descripcion: string;
    /** Precio sin handoffmode (el default). null si no hay. */
    precio: number | null;
    gruposOpciones: GrupoOpcionesOlo[];
    /**
     * Atributos de horario (availability, times, startdate, enddate) e
     * isdisabled. Se leen solo para poder decir en los logs que se IGNORAN: no
     * son 86, y isdisabled esta deprecado ("Do not use").
     */
    ignorados: string[];
}

export interface CategoriaOlo {
    id: string;
    nombre: string;
    productos: ProductoOlo[];
}

export interface MenuOlo {
    vendorId: string | null;
    vendorNombre: string | null;
    categorias: CategoriaOlo[];
}

export interface VendorExportParser {
    parsear(xml: string): MenuOlo;
}

const LISTAS = new Set([
    'brand', 'vendor', 'category', 'product', 'optiongroup', 'option', 'price', 'singleusecategory'
]);

function valor(nodo: any, campo: string): string | null {
    if (!nodo || typeof nodo !== 'object') return null;
    const v = nodo[campo] ?? nodo[`@${campo}`];
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') {
        const t = v['#text'];
        return t === undefined || t === null ? null : String(t).trim();
    }
    const s = String(v).trim();
    return s === '' ? null : s;
}

function numero(s: string | null): number | null {
    if (s === null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** Hijos de un contenedor: <optiongroups><optiongroup/>...</optiongroups> o <optiongroup/> directo. */
function hijos(nodo: any, contenedor: string, elemento: string): any[] {
    if (!nodo || typeof nodo !== 'object') return [];
    const c = nodo[contenedor];
    const dentro = c && typeof c === 'object' ? c[elemento] : undefined;
    const directos = nodo[elemento];
    const lista = dentro ?? directos ?? [];
    return Array.isArray(lista) ? lista : [lista];
}

function precioPorDefecto(producto: any): number | null {
    // <pricing><price handoffmode="..." amount="..."/></pricing>: el que no
    // tiene handoffmode es el precio base. Sin pricing, cost.
    const precios = hijos(producto, 'pricing', 'price');
    const base = precios.find(p => !valor(p, 'handoffmode')) ?? null;
    const desdePricing = base ? numero(valor(base, 'amount') ?? valor(base, 'price')) : null;
    return desdePricing ?? numero(valor(producto, 'cost'));
}

export class VendorExportParserXml implements VendorExportParser {

    private xml = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        // Los ids son int64: todo queda como texto, nadie convierte a number.
        parseAttributeValue: false,
        parseTagValue: false,
        trimValues: true,
        isArray: (nombre) => LISTAS.has(nombre)
    });

    public parsear(xml: string): MenuOlo {
        const raiz = this.xml.parse(xml);
        const vendor = this.buscarVendor(raiz);
        if (!vendor) throw new Error('Vendor Export sin elemento vendor');

        const menu = vendor.menu ?? vendor;
        const categorias = hijos(menu, 'categories', 'category').map(c => this.categoria(c));

        return {
            vendorId: valor(vendor, 'id'),
            vendorNombre: valor(vendor, 'name'),
            categorias
        };
    }

    private buscarVendor(raiz: any): any {
        const exp = raiz?.menuexport ?? raiz?.vendorexport ?? raiz;
        for (const brand of hijos(exp, 'brands', 'brand')) {
            const v = hijos(brand, 'vendors', 'vendor')[0];
            if (v) return v;
        }
        return hijos(exp, 'vendors', 'vendor')[0] ?? null;
    }

    private categoria(c: any): CategoriaOlo {
        return {
            id: valor(c, 'id') ?? '',
            nombre: valor(c, 'name') ?? '',
            productos: hijos(c, 'products', 'product').map(p => this.producto(p))
        };
    }

    private producto(p: any): ProductoOlo {
        const ignorados = ['isdisabled', 'availability', 'times', 'startdate', 'enddate']
            .filter(campo => p?.[campo] !== undefined);
        return {
            id: valor(p, 'id') ?? '',
            chainId: valor(p, 'chainproductid'),
            nombre: valor(p, 'name') ?? '',
            descripcion: valor(p, 'description') ?? '',
            precio: precioPorDefecto(p),
            gruposOpciones: hijos(p, 'optiongroups', 'optiongroup').map(g => this.grupo(g)),
            ignorados
        };
    }

    private grupo(g: any): GrupoOpcionesOlo {
        return {
            id: valor(g, 'id') ?? '',
            nombre: valor(g, 'name') ?? valor(g, 'description') ?? '',
            opciones: hijos(g, 'options', 'option').map(o => this.opcion(o))
        };
    }

    private opcion(o: any): OpcionOlo {
        return {
            id: valor(o, 'id') ?? '',
            chainId: valor(o, 'chainoptionid'),
            nombre: valor(o, 'name') ?? '',
            costo: numero(valor(o, 'cost')),
            gruposOpciones: hijos(o, 'optiongroups', 'optiongroup').map(g => this.grupo(g))
        };
    }
}

export const vendorExportParser: VendorExportParser = new VendorExportParserXml();
