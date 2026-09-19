import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
      },
    },
  },
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*subsystems*', '*apps*'],
              message: 'core/ must not import subsystems/ or apps/',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/subsystems/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*subsystems*'],
              message: 'subsystems/ must not import other subsystems/',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/infrastructure/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*subsystems*', '*adapters*', '*apps*'],
              message: 'infrastructure/ must depend only on core/ contracts',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/adapters/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*subsystems*'],
              message: 'adapters/ must not import subsystems/',
            },
          ],
        },
      ],
    },
  },
);
