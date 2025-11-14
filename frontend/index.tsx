import { Icon, initializeBlock, loadScriptFromURLAsync } from '@airtable/blocks/ui';
import { Tab } from '@headlessui/react';
import React, { Fragment } from 'react';
import { IconName } from '@airtable/blocks/dist/types/src/ui/icon_config';
import { PresetManager } from './components/PresetManager';
import { MainPage } from './MainPage';

const MyTabLink = ({ icon, label }: { icon: IconName; label: string }) => {
  return (
    <Tab as={Fragment}>
      {({ selected }) => (
        <button className={'flex px-2 py-1 ' + (selected ? 'text-slate-50' : 'text-slate-400')}>
          <Icon name={icon} size={16} />
          <span className="ml-1 text-xs font-medium uppercase tracking-widest">{label}</span>
        </button>
      )}
    </Tab>
  );
};

function App() {
  return (
    <main className="min-h-screen bg-slate-50">
      <Tab.Group>
        <Tab.List className="flex w-auto items-center justify-between gap-2 overflow-x-auto bg-slate-500 p-1 sm:gap-4">
          <div className="flex items-center">
            <MyTabLink icon="aiAssistant" label="Bucket Classifier" />
          </div>
          <PresetManager />
        </Tab.List>
        <Tab.Panels className="p-4 sm:p-6">
          <Tab.Panel>
            <MainPage />
          </Tab.Panel>
        </Tab.Panels>
      </Tab.Group>
    </main>
  );
}

loadScriptFromURLAsync('https://cdn.tailwindcss.com').then(async () => {
  initializeBlock(() => <App />);
});
