import 'reflect-metadata';

import { timingSafeEqual } from 'node:crypto';

import { receipt } from '@checkoff/contracts';
import type { Receipt } from '@checkoff/contracts';
import { fromEnvInt, instanceId, required } from '@checkoff/infra';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Post,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import PDFDocument from 'pdfkit';

const money = (cents: number) => (cents / 100).toFixed(2).replace('.', ',') + ' EUR';
const percent = (rate: number) => String(rate / 100).replace('.', ',') + ' %';

function render({ sale, invoice, type, seller }: Receipt): PDFKit.PDFDocument {
  const document = new PDFDocument({ size: 'A4', margin: 48 });
  document.fontSize(22).text(type === 'ticket' ? 'Ticket de caisse' : `Facture ${invoice?.number}`);
  document.moveDown(0.5).fontSize(11).text(seller.name);
  if (seller.address) document.text(seller.address);
  if (seller.taxId) document.text(`Identifiant fiscal : ${seller.taxId}`);
  document.text(`Vente : ${sale.id}`).text(`Paiement (UTC) : ${sale.paidAt}`);
  if (invoice)
    document
      .moveDown()
      .text(`Émission : ${invoice.issuedAt.slice(0, 10)}`)
      .text('Facturé à')
      .text(invoice.name)
      .text(invoice.address);
  document.moveDown();
  for (const line of sale.lines) {
    if (document.y > 710) document.addPage();
    document.font('Helvetica-Bold').text(line.name);
    document
      .font('Helvetica')
      .text(
        `${line.gencod}  |  ${line.quantity} × ${money(line.unitPriceCents)}  |  TVA ${percent(line.vatRateBps)}  |  ${money(line.totalCents)}`,
      );
    document.moveDown(0.4);
  }
  if (document.y > 650) document.addPage();
  document.moveDown().text(`Total HT : ${money(sale.totals.netCents)}`);
  for (const tax of sale.totals.vatBreakdown)
    document.text(`TVA ${percent(tax.rateBps)} : ${money(tax.amountCents)}`);
  document.font('Helvetica-Bold').text(`Total TTC : ${money(sale.totals.totalCents)}`);
  document
    .font('Helvetica')
    .text(
      sale.payment?.method === 'cash'
        ? `Espèces · Monnaie rendue : ${money(sale.payment.changeCents)}`
        : 'Carte (simulation)',
    );
  document.end();
  return document;
}

@Controller()
class ReceiptController {
  private readonly secret = Buffer.from(required('INTERNAL_TOKEN', 32));

  @Get('health')
  health() {
    return { service: 'receipt', status: 'ok', instance: instanceId() };
  }

  @Post('internal/receipt')
  @HttpCode(200)
  generate(@Headers('x-checkoff-internal') token: string | undefined, @Body() payload: unknown) {
    const received = Buffer.from(token ?? '');
    if (received.length !== this.secret.length || !timingSafeEqual(received, this.secret))
      throw new UnauthorizedException();
    const parsed = receipt.safeParse(payload);
    if (
      !parsed.success ||
      !parsed.data.sale.paidAt ||
      !parsed.data.sale.payment ||
      (parsed.data.type === 'invoice' && parsed.data.invoice?.saleId !== parsed.data.sale.id)
    )
      throw new BadRequestException('Justificatif invalide.');
    const { type, sale } = parsed.data;
    return new StreamableFile(render(parsed.data), {
      type: 'application/pdf',
      disposition: `attachment; filename="${type}-${sale.id}.pdf"`,
    });
  }
}

@Module({ controllers: [ReceiptController] })
class ReceiptModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(ReceiptModule, {
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '512kb' });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  await app.listen(fromEnvInt('PORT', 8080), '0.0.0.0');
}
await main();
