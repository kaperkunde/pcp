// The Touch ID key in the data-protection keychain, as an item macOS itself
// releases only after a fingerprint (kSecAccessControlBiometryCurrentSet):
// no process reads it without one, PCP's own included. This file only talks
// to the keychain; the wrapper (touch-id-store.mjs) decides what the answers
// mean, and has the tests.
//
// The data-protection keychain needs the keychain-access-groups
// entitlement, which a Developer ID app gets only from an embedded
// provisioning profile (scripts/dist.mjs). Without it every call answers
// errSecMissingEntitlement (-34018), and the wrapper keeps the key its
// other way.
//
//   status()     -> { biometrics, entitled, saved, stale, code }
//   store(key)   -> OSStatus
//   read(reason) -> Promise<{ code, key? }>, showing the fingerprint sheet
//   remove()     -> OSStatus
//
// Adding or removing a fingerprint voids the item. `stale` says so ahead of
// a read: the item carries the set of fingerprints it was made under
// (LAContext's evaluatedPolicyDomainState), compared with today's.

#define __STDC_WANT_LIB_EXT1__ 1

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#define MAX_KEY_BYTES 256
#define MAX_REASON_BYTES 512

static NSString *const kService = @"com.kaperkunde.pcp.touch-id";
static NSString *const kAccount = @"device-key";

static NSMutableDictionary *ItemQuery(void) {
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : kService,
    (__bridge id)kSecAttrAccount : kAccount,
    (__bridge id)kSecUseDataProtectionKeychain : @YES,
  } mutableCopy];
}

// The enrolled fingerprints as LocalAuthentication describes them, or nil
// when Touch ID cannot be used now (none enrolled, or the lid is closed).
static NSData *EnrolledFingerprints(void) {
  LAContext *context = [[LAContext alloc] init];
  NSError *error = nil;
  if (![context
          canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                      error:&error]) {
    return nil;
  }
  return context.evaluatedPolicyDomainState;
}

static void Wipe(void *bytes, size_t length) {
  if (bytes && length > 0) {
    memset_s(bytes, length, 0, length);
  }
}

static napi_value Int(napi_env env, int32_t value) {
  napi_value result = NULL;
  napi_create_int32(env, value, &result);
  return result;
}

static napi_value Bool(napi_env env, bool value) {
  napi_value result = NULL;
  napi_get_boolean(env, value, &result);
  return result;
}

static void Set(napi_env env, napi_value object, const char *name,
                napi_value value) {
  napi_set_named_property(env, object, name, value);
}

// --- status ------------------------------------------------------------

static napi_value Status(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    NSData *enrolled = EnrolledFingerprints();

    // Asks for the item's attributes without ever showing a prompt: found,
    // found but behind the fingerprint, not there, or not allowed at all.
    LAContext *silent = [[LAContext alloc] init];
    silent.interactionNotAllowed = YES;
    NSMutableDictionary *query = ItemQuery();
    query[(__bridge id)kSecReturnAttributes] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    query[(__bridge id)kSecUseAuthenticationContext] = silent;

    CFTypeRef found = NULL;
    OSStatus code =
        SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
    NSDictionary *attributes =
        found ? (__bridge_transfer NSDictionary *)found : nil;

    bool saved = code == errSecSuccess || code == errSecInteractionNotAllowed;
    bool stale = false;
    if (code == errSecSuccess && enrolled != nil) {
      id recorded = attributes[(__bridge id)kSecAttrGeneric];
      stale = ![recorded isKindOfClass:[NSData class]] ||
              ![(NSData *)recorded isEqualToData:enrolled];
    }

    napi_value result = NULL;
    napi_create_object(env, &result);
    Set(env, result, "biometrics", Bool(env, enrolled != nil));
    Set(env, result, "entitled", Bool(env, code != errSecMissingEntitlement));
    Set(env, result, "saved", Bool(env, saved));
    Set(env, result, "stale", Bool(env, stale));
    Set(env, result, "code", Int(env, code));
    return result;
  }
}

// --- store -------------------------------------------------------------

static napi_value Store(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  size_t length = 0;
  if (argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok ||
      length == 0 || length > MAX_KEY_BYTES) {
    napi_throw_type_error(env, NULL, "store takes the key, as a string");
    return NULL;
  }

  char key[MAX_KEY_BYTES + 1];
  napi_get_value_string_utf8(env, argv[0], key, sizeof key, &length);

  OSStatus code;
  @autoreleasepool {
    NSData *enrolled = EnrolledFingerprints();
    CFErrorRef error = NULL;
    SecAccessControlRef access =
        enrolled == nil
            ? NULL
            : SecAccessControlCreateWithFlags(
                  kCFAllocatorDefault,
                  kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                  kSecAccessControlBiometryCurrentSet, &error);
    if (error) {
      CFRelease(error);
    }

    if (enrolled == nil) {
      code = errSecNotAvailable;
    } else if (access == NULL) {
      code = errSecParam;
    } else {
      SecItemDelete((__bridge CFDictionaryRef)ItemQuery());

      NSMutableDictionary *item = ItemQuery();
      item[(__bridge id)kSecAttrLabel] = @"PCP Touch ID";
      item[(__bridge id)kSecAttrGeneric] = enrolled;
      item[(__bridge id)kSecAttrAccessControl] = (__bridge_transfer id)access;
      item[(__bridge id)kSecValueData] = [NSData dataWithBytes:key
                                                        length:length];
      code = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
    }
  }

  Wipe(key, sizeof key);
  return Int(env, code);
}

// --- read --------------------------------------------------------------

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char reason[MAX_REASON_BYTES + 1];
  OSStatus code;
  char *key;
  size_t length;
} ReadJob;

// On a worker thread: SecItemCopyMatching waits while macOS shows the
// fingerprint sheet, and must not hold the main process's event loop.
static void ReadExecute(napi_env env, void *data) {
  ReadJob *job = data;

  @autoreleasepool {
    LAContext *context = [[LAContext alloc] init];
    context.localizedReason =
        [NSString stringWithUTF8String:job->reason] ?: @"unlock PCP";
    // The fingerprint or nothing: the item takes no password.
    context.localizedFallbackTitle = @"";

    NSMutableDictionary *query = ItemQuery();
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    query[(__bridge id)kSecUseAuthenticationContext] = context;

    CFTypeRef found = NULL;
    job->code = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
    NSData *value = found ? (__bridge_transfer NSData *)found : nil;

    if (job->code == errSecSuccess) {
      if (value.length > 0 && value.length <= MAX_KEY_BYTES) {
        job->key = malloc(value.length);
        if (job->key) {
          memcpy(job->key, value.bytes, value.length);
          job->length = value.length;
        } else {
          job->code = errSecAllocate;
        }
      } else {
        job->code = errSecDecode;
      }
    }
  }
}

static void ReadComplete(napi_env env, napi_status status, void *data) {
  ReadJob *job = data;

  napi_value result = NULL;
  napi_create_object(env, &result);
  Set(env, result, "code",
      Int(env, status == napi_ok ? job->code : errSecInternalError));
  if (status == napi_ok && job->code == errSecSuccess && job->key) {
    napi_value key = NULL;
    napi_create_string_utf8(env, job->key, job->length, &key);
    Set(env, result, "key", key);
  }
  napi_resolve_deferred(env, job->deferred, result);
  napi_delete_async_work(env, job->work);

  Wipe(job->key, job->length);
  free(job->key);
  free(job);
}

static napi_value Read(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  ReadJob *job = calloc(1, sizeof *job);
  if (!job) {
    napi_throw_error(env, NULL, "Out of memory.");
    return NULL;
  }

  size_t length = 0;
  if (argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], job->reason,
                                 sizeof job->reason, &length) != napi_ok) {
    free(job);
    napi_throw_type_error(env, NULL, "read takes the reason, as a string");
    return NULL;
  }

  napi_value promise = NULL;
  napi_value name = NULL;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "pcp-keychain-read", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, ReadExecute, ReadComplete, job,
                         &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

// --- remove ------------------------------------------------------------

static napi_value Remove(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    return Int(env, SecItemDelete((__bridge CFDictionaryRef)ItemQuery()));
  }
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"status", NULL, Status, NULL, NULL, NULL, napi_default, NULL},
      {"store", NULL, Store, NULL, NULL, NULL, napi_default, NULL},
      {"read", NULL, Read, NULL, NULL, NULL, napi_default, NULL},
      {"remove", NULL, Remove, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports,
                         sizeof properties / sizeof properties[0],
                         properties);
  return exports;
}
