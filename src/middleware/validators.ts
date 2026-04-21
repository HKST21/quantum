import { body, param, query } from 'express-validator';

export const loginValidator = [
    body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
    body('password').notEmpty().withMessage('Password is required'),
];

export const verifyTwoFactorValidator = [
    body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
    body('token').isString().isLength({ min: 6, max: 6 }).withMessage('Token must be 6 digits'),
];

export const createUserValidator = [
    body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
    body('password').isString().isLength({ min: 12 }).withMessage('Password must be at least 12 characters'),
    body('fullName').isString().trim().isLength({ min: 2, max: 255 }).withMessage('Full name must be between 2 and 255 characters'),
    body('role').isIn(['ADMIN', 'SALES']).withMessage('Role must be either ADMIN or SALES'),
];

export const createLeadValidator = [
    body('companyName').isString().trim().isLength({ min: 2, max: 255 }).withMessage('Company name must be between 2 and 255 characters'),
    body('legalForm').optional().isString().trim().isLength({ max: 100 }),
    body('ico').optional().isString().trim().isLength({ max: 20 }),
    body('contactPerson').isString().trim().isLength({ min: 2, max: 255 }).withMessage('Contact person required'),
    body('phone').isString().trim().isLength({ min: 9, max: 50 }).withMessage('Phone required'),
    body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
    body('status').optional().isIn([
        'NOVY', 'CHCE_NABIDKU', 'CHCE_KONTAKT_AI', 'POSLAL_FAKTURU',
        'NABIDKA_PREDLOZENA', 'CHCE_PODEPSAT_SMLOUVU', 'UZAVRENO',
        'NEDOSTUPNY', 'NEZVEDL_TELEFON', 'ODKLADA', 'ODMITNUTO', 'NEKONTAKTOVAT',
    ]),
    body('assignedTo').optional().isUUID(),
];

export const updateLeadValidator = [
    body('companyName').optional().isString().trim().isLength({ min: 2, max: 255 }),
    body('legalForm').optional().isString().trim().isLength({ max: 100 }),
    body('ico').optional().isString().trim().isLength({ max: 20 }),
    body('contactPerson').optional().isString().trim().isLength({ min: 2, max: 255 }),
    body('phone').optional().isString().trim().isLength({ min: 9, max: 50 }),
    body('email').optional().isEmail().normalizeEmail(),
];

export const changeLeadStatusValidator = [
    body('status').isIn([
        'NOVY', 'CHCE_NABIDKU', 'CHCE_KONTAKT_AI', 'POSLAL_FAKTURU',
        'NABIDKA_PREDLOZENA', 'CHCE_PODEPSAT_SMLOUVU', 'UZAVRENO',
        'NEDOSTUPNY', 'NEZVEDL_TELEFON', 'ODKLADA', 'ODMITNUTO', 'NEKONTAKTOVAT',
    ]).withMessage('Invalid status'),
    body('comment').isString().trim().isLength({ min: 1, max: 5000 }).withMessage('Comment required'),
];

export const assignLeadValidator = [
    body('assignedTo').isUUID().withMessage('Assigned user must be a valid UUID'),
];

export const uuidParamValidator = [
    param('id').isUUID().withMessage('Invalid UUID'),
];

export const skipLeadValidator = [
    body('comment').isString().trim().isLength({ min: 30, max: 5000 }).withMessage('Comment must be at least 30 characters'),
];

export const leadListQueryValidator = [
    query('status').optional().isIn([
        'NOVY', 'CHCE_NABIDKU', 'CHCE_KONTAKT_AI', 'POSLAL_FAKTURU',
        'NABIDKA_PREDLOZENA', 'CHCE_PODEPSAT_SMLOUVU', 'UZAVRENO',
        'NEDOSTUPNY', 'NEZVEDL_TELEFON', 'ODKLADA', 'ODMITNUTO', 'NEKONTAKTOVAT',
    ]),
    query('assignedTo').optional().isUUID(),
    query('search').optional().isString().trim().isLength({ max: 255 }),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 500 }),
];

export const phoneScreeningValidator = [
    body('currentProviderType').optional().isIn(['T-Mobile', 'O2', 'Předplacenka', 'Jiný']),
    body('currentProviderOther').optional().isString().trim().isLength({ max: 100 }),
    body('monthlyTotal').optional().isFloat({ min: 0 }),
    body('monthlyTotalUnknown').optional().isBoolean(),
    body('phoneCount').optional().isInt({ min: 0 }),
    body('phoneCountUnknown').optional().isBoolean(),
    body('phoneUnlimited').optional().isBoolean(),
    body('phoneUnlimitedUnknown').optional().isBoolean(),
    body('hasFixedInternet').optional().isBoolean(),
    body('fixedInternetCount').optional().isInt({ min: 0 }),
    body('fixedInternetCountUnknown').optional().isBoolean(),
    body('hasMobileInternet').optional().isBoolean(),
    body('mobileInternetCount').optional().isInt({ min: 0 }),
    body('mobileInternetCountUnknown').optional().isBoolean(),
    body('hasTv').optional().isBoolean(),
    body('tvCount').optional().isInt({ min: 0 }),
    body('tvCountUnknown').optional().isBoolean(),
    body('notes').optional().isString().trim().isLength({ max: 5000 }),
];

export const invoiceDataValidator = [
    body('currentProviderType').optional().isIn(['T-Mobile', 'O2', 'Předplacenka', 'Jiný']),
    body('currentProviderOther').optional().isString().trim().isLength({ max: 100 }),
    body('deviceInstallmentsNote').optional().isString().trim().isLength({ max: 1000 }),
    body('contractEndDate').optional().isISO8601(),
    body('tariffs').isArray({ min: 0 }),
    body('tariffs.*.tariffName').isString().trim().isLength({ min: 1, max: 200 }),
    body('tariffs.*.unitPrice').isFloat({ min: 0 }),
    body('tariffs.*.quantity').isInt({ min: 1 }),
    body('tariffs.*.totalPrice').isFloat({ min: 0 }),
    body('tariffs.*.notes').optional().isString().trim().isLength({ max: 500 }),
    body('notes').optional().isString().trim().isLength({ max: 5000 }),
];

export const updateLeadEmailValidator = [
    body('email').isEmail().normalizeEmail().withMessage('Neplatný formát emailu'),
];