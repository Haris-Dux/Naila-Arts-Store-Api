import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { AdminSeedService } from './admin-seed.service';
import { User, UserSchema } from './schemas/user.schema';
import { UserProfileCacheService } from './user-profile-cache.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    // Circular by nature: auth needs user lookups, and the users controller needs
    // to revoke sessions after a role change.
    forwardRef(() => AuthModule),
  ],
  controllers: [UsersController],
  // AdminSeedService creates the first administrator at startup.
  providers: [UsersService, AdminSeedService, UserProfileCacheService],
  exports: [UsersService],
})
export class UsersModule {}
