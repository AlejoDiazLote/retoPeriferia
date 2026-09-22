---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra SAP de Periferia — reglas de control RC1–RC10, criterios de negocio (valor aprobado, IVA incluido, texto breve de 40 caracteres, OC retroactivas) y acciones sugeridas ante bloqueos.
---

## Proceso de órdenes de compra (OC)

Cada compra llega a Administración por correo con tres piezas: la **solicitud** (Excel), la **cotización** del proveedor y el **correo de aprobación** del líder. A veces llega además la **factura**. La analista crea la OC en SAP (sociedad 1000, organización de compras 1000) y adjunta el correo de aprobación en PDF como evidencia.

## Reglas de control

| Regla | Qué verifica | Efecto |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado) y está activo. | Bloqueo |
| RC2 | Hay aprobación, contiene "Aprobado" y la envía un aprobador del centro de costo. | Bloqueo |
| RC3 | El valor total no supera el tope del aprobador en ese centro de costo. | Bloqueo |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo |
| RC5 | La cotización difiere de la solicitud en máximo 2 %. Sin cotización también requiere confirmación. | Confirmación |
| RC6 | Sin indicador de IVA se toma el del proveedor y se confirma. | Confirmación + derivado |
| RC7 | Sin condiciones de pago se toman las del proveedor. | Derivado (informativo) |
| RC8 | Factura con fecha anterior a la solicitud: OC retroactiva, se marca en el log de control. | Confirmación |
| RC9 | La aprobación no puede ser anterior a la solicitud. | Confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1). | Bloqueo |

- **Bloqueo**: la OC no se crea. Se devuelve al humano la razón y la acción sugerida.
- **Confirmación**: la OC se crea solo si la analista lo confirma explícitamente.
- **Derivado**: valor completado desde los maestros; siempre se informa.

## Criterios del negocio

- El valor de la OC es el de la **solicitud** (el aprobado por el líder), no el de la cotización. Si difieren más del 2 %, la analista decide si crear con el valor aprobado o pedir una nueva aprobación.
- Los precios de solicitud y cotización incluyen IVA.
- El texto breve de la posición en SAP admite máximo 40 caracteres; la descripción completa queda en la trazabilidad.
- Unidad de medida: horas → `H`, mensualidades → `MES`, en otro caso `UN`.
- Las **OC retroactivas** (factura antes de la solicitud) son un desvío de proceso: se saltan la cotización y la aprobación previa. La dirección quiere medir su porcentaje, por eso se registran con `retroactiva = true` en `out/control.csv`.
- La creación es **idempotente** por `solicitud_id`: si la OC ya existe, se devuelve el número existente.

## Acciones sugeridas típicas

- Proveedor inexistente o inactivo → Compras debe crearlo/reactivarlo en SAP (RUT, certificación bancaria) o usar un proveedor registrado.
- Aprobador sin autoridad → pedir aprobación a un aprobador del centro de costo con tope suficiente, o corregir el centro de costo.
- Diferencia con la cotización → confirmar con el valor aprobado o pedir al solicitante actualizar solicitud y aprobación.
- Adjunto faltante o datos inválidos → pedir al solicitante que reenvíe el archivo corregido.
