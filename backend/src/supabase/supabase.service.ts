import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private supabase: SupabaseClient;

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('PUBLIC_SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SECRET_SUPABASE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }

    this.supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  async getData(tableName: string) {
    try {
    const { data, error } = await this.supabase.from(tableName).select('*');
    if (error) {
      throw new Error(`Error fetching data: ${error.message}`);
    }
    return data;
    } catch (err) {
      throw new Error(`Unexpected error: ${err}`);
    }
  }
  }

