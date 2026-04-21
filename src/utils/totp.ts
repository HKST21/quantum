import speakeasy from 'speakeasy';
import QRCode from 'qrcode';

export const generateTotpSecret = (email: string): { secret: string; otpauthUrl: string } => {
    const secret = speakeasy.generateSecret({
        name: `Quantum CRM (${email})`,
        issuer: 'Cante Trading',
        length: 32,
    });
    return { secret: secret.base32, otpauthUrl: secret.otpauth_url || '' };
};

export const generateQRCode = async (otpauthUrl: string): Promise<string> => {
    return QRCode.toDataURL(otpauthUrl);
};

export const verifyTotpToken = (token: string, secret: string): boolean => {
    return speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token,
        window: 2,
    });
};

export const setupTwoFactor = async (email: string): Promise<{ secret: string; qrCode: string; manual: string }> => {
    const { secret, otpauthUrl } = generateTotpSecret(email);
    const qrCode = await generateQRCode(otpauthUrl);
    return { secret, qrCode, manual: secret };
};