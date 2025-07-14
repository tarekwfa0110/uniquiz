import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
    constructor(private configService: ConfigService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const SUPABASE_URL = this.configService.get<string>('PUBLIC_SUPABASE_URL');
        const SUPABASE_JWT_SECRET = this.configService.get<string>('SUPABASE_JWT_SECRET');

        if (!SUPABASE_URL || !SUPABASE_JWT_SECRET) {
            throw new UnauthorizedException('Configuration error');
        }

        const SUPABASE_PROJECT_REF = SUPABASE_URL.replace('https://', '').split('.')[0];
        const SUPABASE_JWT_ISSUER = `https://${SUPABASE_PROJECT_REF}.supabase.co/auth/v1`;

        const request = context.switchToHttp().getRequest();
        const authHeader = request.headers['authorization'];
        if (!authHeader) {
            throw new UnauthorizedException('No Authorization header');
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            throw new UnauthorizedException('No token found');
        }

        // Decode token without verification to see its structure
        try {
            const decodedWithoutVerification = jwt.decode(token);
        } catch (err) {
        }

        let decoded: any;
        let verificationError: any;

        // Try HS256 first (most common for Supabase)
        try {
            decoded = jwt.verify(token, SUPABASE_JWT_SECRET, {
                issuer: SUPABASE_JWT_ISSUER,
                algorithms: ['HS256'],
            });
        } catch (err) {
            verificationError = err;
            
            // Try without issuer verification as fallback
            try {
                decoded = jwt.verify(token, SUPABASE_JWT_SECRET, {
                    algorithms: ['HS256'],
                });
            } catch (err2) {
                
                // Try RS256 as last resort
                try {
                    decoded = jwt.verify(token, SUPABASE_JWT_SECRET, {
                        issuer: SUPABASE_JWT_ISSUER,
                        algorithms: ['RS256'],
                    });
                } catch (err3) {
                    throw new UnauthorizedException('Invalid token: ' + verificationError.message);
                }
            }
        }

        request.user = decoded;
        return true;
    }
}