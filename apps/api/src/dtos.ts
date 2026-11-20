import {
  article,
  articlePatch,
  billingDetails,
  code,
  delivery,
  documentType,
  errorEnvelope,
  gencod,
  invoice,
  login,
  loyaltyInput,
  loyaltyLink,
  loyaltyResult,
  loyaltyUpdate,
  page,
  paymentInput,
  quantityInput,
  queryCursor,
  sale,
  saleSummary,
  session,
  stock,
  stockInput,
  user,
  userInput,
  username,
  userState,
  uuid,
} from '@checkoff/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class LoginDto extends createZodDto(login) {}
export class SessionDto extends createZodDto(session) {}
export class UserDto extends createZodDto(user) {}
export class UserInputDto extends createZodDto(userInput) {}
export class UserStateDto extends createZodDto(userState) {}
export class UsersDto extends createZodDto(page(user)) {}
export class UserCursor extends createZodDto(queryCursor(username)) {}
export class IdParam extends createZodDto(z.object({ id: uuid })) {}

export class ArticleDto extends createZodDto(article) {}
export class ArticlesDto extends createZodDto(page(article)) {}
export class ArticlePatchDto extends createZodDto(articlePatch) {}
export class StockDto extends createZodDto(stock) {}
export class StocksDto extends createZodDto(page(stock)) {}
export class StockInputDto extends createZodDto(stockInput) {}
export class GencodCursor extends createZodDto(queryCursor(gencod)) {}
export class GencodParam extends createZodDto(z.object({ gencod })) {}
export class LoyaltyInputDto extends createZodDto(loyaltyInput) {}
export class LoyaltyDto extends createZodDto(loyaltyResult) {}
export class LoyaltyUpdateDto extends createZodDto(loyaltyUpdate) {}
export class LoyaltyLinkDto extends createZodDto(loyaltyLink) {}
export class CodeParam extends createZodDto(z.object({ code })) {}

export class SaleDto extends createZodDto(sale) {}
export class SalesDto extends createZodDto(page(saleSummary)) {}
export class SaleCursor extends createZodDto(queryCursor(uuid)) {}
export class LineParam extends createZodDto(z.object({ id: uuid, gencod })) {}
export class DocumentParam extends createZodDto(z.object({ id: uuid, type: documentType })) {}
export class QuantityDto extends createZodDto(quantityInput) {}
export class PaymentDto extends createZodDto(paymentInput) {}
export class BillingDto extends createZodDto(billingDetails) {}
export class InvoiceDto extends createZodDto(invoice) {}
export class DeliveryDto extends createZodDto(delivery) {}
export class ErrorDto extends createZodDto(errorEnvelope) {}
