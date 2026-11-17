import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vendorExportParser } from './vendorExport.parser';
import { aplanarVendorExport, formatearPrecio, fusionarOchentaYSeis, recolectarCategorias } from './menuFlatten.service';

/**
 * Parser del Vendor Export (SYNTHETIC) y aplanado con MENU_CONFIG.
 * MENU_CONFIG viene de .env.test: Burgers 1, Drinks 2, Fries Size 3,
 * "Grupo de mods excluido" con includeItems false.
 */

const xml = readFileSync(join(import.meta.dir, '..', '..', 'fixtures', 'vendor-export', 'synthetic.xml'), 'utf-8');
const menu = vendorExportParser.parsear(xml);

describe('parser del Vendor Export (SYNTHETIC)', () => {

    test('lee vendor, categorias, productos y opciones con ids de 17 digitos intactos', () => {
        expect(menu.vendorId).toBe('10000000000000001');
        expect(menu.vendorNombre).toBe('Synthetic Store');
        expect(menu.categorias.map(c => c.nombre)).toEqual(['Burgers', 'Drinks', 'Secret']);
        const p1 = menu.categorias[0].productos[0];
        expect(p1.id).toBe('90000000000000011');
        expect(p1.chainId).toBe('80000000000000011');
        expect(p1.gruposOpciones[0].opciones.map(o => o.id)).toEqual(['90000000000000021', '90000000000000022']);
    });

    test('el precio por defecto es el de pricing sin handoffmode', () => {
        expect(menu.categorias[0].productos[0].precio).toBe(12.5);
    });

    test('isdisabled y horarios se leen solo para avisar que se ignoran', () => {
        expect(menu.categorias[0].productos[0].ignorados).toEqual(['isdisabled']);
        expect(menu.categorias[1].productos[0].ignorados).toEqual(['availability', 'times', 'startdate', 'enddate']);
    });

    test('acepta campos como elementos hijos ademas de atributos', () => {
        const alt = vendorExportParser.parsear(
            `<menuexport><vendors><vendor><id>5</id><name>X</name><menu><categories><category><id>1</id><name>Burgers</name>` +
            `<products><product><id>90000000000000099</id><name>Hijo</name><cost>4</cost></product></products>` +
            `</category></categories></menu></vendor></vendors></menuexport>`);
        expect(alt.categorias[0].productos[0]).toMatchObject({ id: '90000000000000099', nombre: 'Hijo', precio: 4 });
    });

    test('un XML sin vendor lanza', () => {
        expect(() => vendorExportParser.parsear('<menuexport/>')).toThrow();
    });
});

describe('aplanado con MENU_CONFIG', () => {

    test('solo las categorias configuradas, con su numero de menu', () => {
        const filas = aplanarVendorExport(menu);
        expect(filas.filter(f => f.item_type === 'PRODUCT').map(f => [f.name, f.menu_number])).toEqual([
            ['Classic Burger', 1], ['Double Burger', 1], ['Lemonade', 2]
        ]);
    });

    test('modificadores: pos_id + __mod, categoria con Group ID, padre = categoria del producto', () => {
        const mods = aplanarVendorExport(menu).filter(f => f.item_type === 'MODIFIER');
        expect(mods.map(m => m.pos_id)).toEqual(['90000000000000021__mod', '90000000000000022__mod']);
        expect(mods[0]).toMatchObject({
            category: 'Choose a Side (Group ID: 40000000000000001)', parent_group: 'Burgers', menu_number: 1, price: '$0.00'
        });
    });

    test('la misma opcion en dos productos se exporta una sola vez', () => {
        const ids = aplanarVendorExport(menu).map(f => f.pos_id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('profundidad: los optiongroups anidados solo con OLO_MODIFIER_DEPTH >= 2, y pisan el numero si estan configurados', () => {
        expect(aplanarVendorExport(menu, 1).some(f => f.name === 'Large Fries')).toBe(false);
        const anidado = aplanarVendorExport(menu, 2).find(f => f.name === 'Large Fries')!;
        expect(anidado.menu_number).toBe(3); // "Fries Size" esta en MENU_CONFIG con 3
        expect(anidado.parent_group).toBe('Burgers');
    });

    test('el aplanado nunca decide stock', () => {
        expect(aplanarVendorExport(menu).every(f => f.in_stock === true && f.out_of_stock_icon === '')).toBe(true);
    });

    test('formato de precio igual que Toast', () => {
        expect(formatearPrecio(12.5)).toBe('$12.50');
        expect(formatearPrecio(null)).toBeNull();
        expect(formatearPrecio(NaN)).toBeNull();
    });
});

describe('fusionarOchentaYSeis', () => {

    const filas = aplanarVendorExport(menu);

    test('el conjunto 86 manda siempre, en los dos sentidos', () => {
        const agotada = { ...filas[0], in_stock: false };
        const { filas: r, agotados } = fusionarOchentaYSeis([agotada, filas[1]], new Set([filas[1].pos_id]));
        expect(r[0].in_stock).toBe(true);  // fuera del conjunto = en stock
        expect(r[1].in_stock).toBe(false);
        expect(agotados).toBe(1);
    });

    test('un modificador se busca con su __mod', () => {
        const mod = filas.find(f => f.item_type === 'MODIFIER')!;
        expect(fusionarOchentaYSeis([mod], new Set([mod.pos_id])).filas[0].in_stock).toBe(false);
        expect(fusionarOchentaYSeis([mod], new Set([mod.pos_id.replace('__mod', '')])).filas[0].in_stock).toBe(true);
    });

    test('no muta las filas originales', () => {
        const copia = structuredClone(filas);
        fusionarOchentaYSeis(filas, new Set(filas.map(f => f.pos_id)));
        expect(filas).toEqual(copia);
    });
});

describe('recolectarCategorias', () => {
    test('categorias y optiongroups, con ruta', () => {
        const c = recolectarCategorias(menu);
        expect(c.find(x => x.groupName === 'Fries Size')).toMatchObject({
            kind: 'optiongroup', menuPath: 'Synthetic Store > Burgers > Choose a Side > Fries Size'
        });
    });
});
