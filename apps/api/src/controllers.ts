import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Admin, AuthService, CurrentActor, Public } from './auth.js';
import type { Actor } from './auth.js';
import { CatalogService } from './catalog.js';
import {
  ArticleDto,
  ArticlePatchDto,
  ArticlesDto,
  BillingDto,
  CodeParam,
  DeliveryDto,
  DocumentParam,
  ErrorDto,
  GencodCursor,
  GencodParam,
  IdParam,
  InvoiceDto,
  LineParam,
  LoginDto,
  LoyaltyDto,
  LoyaltyInputDto,
  LoyaltyLinkDto,
  LoyaltyUpdateDto,
  PaymentDto,
  QuantityDto,
  SaleCursor,
  SaleDto,
  SalesDto,
  SessionDto,
  StockDto,
  StockInputDto,
  StocksDto,
  UserCursor,
  UserDto,
  UserInputDto,
  UsersDto,
  UserStateDto,
} from './dtos.js';
import { SalesService } from './sales.js';

@ApiTags('Authentification')
@ApiBadRequestResponse({ type: ErrorDto })
@ApiUnauthorizedResponse({ type: ErrorDto })
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @ApiCreatedResponse({ type: SessionDto })
  login(@Ip() ip: string, @Body() input: LoginDto) {
    return this.auth.login(ip, input);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserDto })
  me(@CurrentActor() { id, username, role, active }: Actor) {
    return { id, username, role, active };
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiResponse({ status: 204 })
  logout(@CurrentActor() actor: Actor) {
    return this.auth.logout(actor);
  }
}

@ApiTags('Utilisateurs')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorDto })
@Admin()
@Controller('api/users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @ApiOkResponse({ type: UsersDto })
  all(@Query() { after }: UserCursor) {
    return this.auth.list(after);
  }

  @Post()
  @ApiCreatedResponse({ type: UserDto })
  create(@Body() input: UserInputDto) {
    return this.auth.create(input);
  }

  @Patch(':id')
  @ApiOkResponse({ type: UserDto })
  setActive(@Param() { id }: IdParam, @Body() { active }: UserStateDto) {
    return this.auth.setActive(id, active);
  }
}

@ApiTags('Catalogue et stock')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: ErrorDto })
@ApiUnauthorizedResponse({ type: ErrorDto })
@ApiNotFoundResponse({ type: ErrorDto })
@Controller('api')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('articles')
  @ApiOkResponse({ type: ArticlesDto })
  list(@Query() { after }: GencodCursor) {
    return this.catalog.list(after);
  }

  @Get('articles/:gencod')
  @ApiOkResponse({ type: ArticleDto })
  find(@Param() { gencod }: GencodParam) {
    return this.catalog.find(gencod);
  }

  @Admin()
  @Post('articles')
  @ApiCreatedResponse({ type: ArticleDto })
  create(@Body() product: ArticleDto) {
    return this.catalog.create(product);
  }

  @Admin()
  @Patch('articles/:gencod')
  @ApiOkResponse({ type: ArticleDto })
  update(@Param() { gencod }: GencodParam, @Body() patch: ArticlePatchDto) {
    return this.catalog.update(gencod, patch);
  }

  @Get('stock')
  @ApiOkResponse({ type: StocksDto })
  inventory(@Query() { after }: GencodCursor) {
    return this.catalog.inventory(after);
  }

  @Get('stock/:gencod')
  @ApiOkResponse({ type: StockDto })
  stock(@Param() { gencod }: GencodParam) {
    return this.catalog.stock(gencod);
  }

  @Admin()
  @Put('stock/:gencod')
  @ApiOkResponse({ type: StockDto })
  setStock(@Param() { gencod }: GencodParam, @Body() { onHand }: StockInputDto) {
    return this.catalog.setStock(gencod, onHand);
  }
}

@ApiTags('Fidélité')
@ApiBearerAuth()
@Controller('api/loyalty-cards')
export class LoyaltyController {
  constructor(private readonly catalog: CatalogService) {}

  @Post()
  @ApiCreatedResponse({ type: LoyaltyDto })
  create(@Body() { code, email }: LoyaltyInputDto) {
    return this.catalog.createCard(code, email);
  }

  @Admin()
  @Patch(':code')
  @ApiOkResponse({ type: LoyaltyDto })
  update(@Param() { code }: CodeParam, @Body() { email }: LoyaltyUpdateDto) {
    return this.catalog.updateCard(code, email);
  }

  @Admin()
  @Delete(':code')
  @HttpCode(204)
  @ApiResponse({ status: 204 })
  remove(@Param() { code }: CodeParam) {
    return this.catalog.deleteCard(code);
  }
}

@ApiTags('Caisse')
@ApiBadRequestResponse({ type: ErrorDto })
@ApiUnauthorizedResponse({ type: ErrorDto })
@ApiConflictResponse({ type: ErrorDto })
@ApiNotFoundResponse({ type: ErrorDto })
@ApiBearerAuth()
@Controller('api/checkouts')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  @ApiCreatedResponse({ type: SaleDto })
  create(@CurrentActor() actor: Actor) {
    return this.sales.create(actor);
  }

  @Get()
  @ApiOkResponse({ type: SalesDto })
  list(@Query() { after }: SaleCursor, @CurrentActor() actor: Actor) {
    return this.sales.list(actor, after);
  }

  @Get(':id')
  @ApiOkResponse({ type: SaleDto })
  find(@Param() { id }: IdParam, @CurrentActor() actor: Actor) {
    return this.sales.find(id, actor);
  }

  @Put(':id/lines/:gencod')
  @ApiOkResponse({ type: SaleDto })
  setLine(
    @Param() { id, gencod }: LineParam,
    @Body() { quantity }: QuantityDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.sales.setLine(id, gencod, quantity, actor);
  }

  @Delete(':id/lines/:gencod')
  @ApiOkResponse({ type: SaleDto })
  removeLine(@Param() { id, gencod }: LineParam, @CurrentActor() actor: Actor) {
    return this.sales.removeLine(id, gencod, actor);
  }

  @Put(':id/loyalty-card')
  @ApiOkResponse({ type: SaleDto })
  link(@Param() { id }: IdParam, @Body() { code }: LoyaltyLinkDto, @CurrentActor() actor: Actor) {
    return this.sales.linkCard(id, code, actor);
  }

  @Post(':id/finalize')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Encaisser la vente. Répéter le même corps pour obtenir le même résultat après une coupure.',
  })
  @ApiOkResponse({ type: SaleDto })
  @ApiResponse({ status: 422, type: ErrorDto })
  finalize(@Param() { id }: IdParam, @Body() body: PaymentDto, @CurrentActor() actor: Actor) {
    return this.sales.finalize(id, body, actor);
  }

  @Put(':id/invoice')
  @ApiOkResponse({ type: InvoiceDto })
  issueInvoice(@Param() { id }: IdParam, @Body() input: BillingDto, @CurrentActor() actor: Actor) {
    return this.sales.issueInvoice(id, input, actor);
  }

  @Get(':id/documents/:type')
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async document(@Param() { id, type }: DocumentParam, @CurrentActor() actor: Actor) {
    const pdf = await this.sales.pdf(id, type, actor);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="${type}-${id}.pdf"`,
    });
  }

  @Post(':id/documents/:type/email')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Planifier l’envoi SMTP. Consulter la même URL avec GET pour suivre le job.',
  })
  @ApiResponse({ status: 202, type: DeliveryDto })
  enqueue(@Param() { id, type }: DocumentParam, @CurrentActor() actor: Actor) {
    return this.sales.enqueue(id, type, actor);
  }

  @Get(':id/documents/:type/email')
  @ApiOkResponse({ type: DeliveryDto })
  delivery(@Param() { id, type }: DocumentParam, @CurrentActor() actor: Actor) {
    return this.sales.delivery(id, type, actor);
  }
}
