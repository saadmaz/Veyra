declare const brand: unique symbol;

/**
 * An open database transaction, handed from one module to another so that work they share
 * commits or rolls back together (e.g. a facility booking and the invoice that charges it),
 * without either module's application layer seeing the database client. Only infrastructure
 * code creates or opens one.
 */
export type TransactionHandle = { readonly [brand]: 'TransactionHandle' };
