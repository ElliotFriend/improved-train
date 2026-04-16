<script lang="ts">
    import './layout.css';

    import Header from '$lib/components/ui/Header.svelte';
    import Footer from '$lib/components/ui/Footer.svelte';
    import AccountSetupBanner from '$lib/components/ui/AccountSetupBanner.svelte';

    let { children } = $props();
</script>

<div class="flex min-h-screen flex-col bg-gray-50 text-gray-900">
    <Header />
    <AccountSetupBanner />

    <main class="mx-auto flex w-full max-w-4xl flex-1 flex-col px-6 py-10">
        {@render children()}
    </main>

    <Footer />
</div>
